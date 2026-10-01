import assert from 'node:assert';
import crypto from 'node:crypto';
import { Request as OauthRequest, Response as OauthResponse } from '@node-oauth/oauth2-server';
import type { APObject as ApexObject, JsonLdActor } from '../apex/index.js';
import type { APNote, APActor, APObject } from 'activitypub-types';
import cors from 'cors';
import express from 'express';
import firebase from 'firebase-admin';
import { chunk, last, uniq, zip } from 'lodash-es';
import type { mastodon } from 'masto';
import { z } from 'zod';
import { apex } from '../activitypub.js';
import {
	domain,
	escapeFirestoreKey,
	mastodonDomain,
	toFirestoreKey,
	unescapeFirestoreKey,
} from '../firebase.js';
import { getMastodonIds, mastodonIdToTimestamp } from '../mastodonId.js';
import { metaIndexPath } from '../meta.js';
import { Clients, Streams, UserInfo, UserInfos } from '../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../store.js';
import type { CamelToSnake } from '../utils.js';
import { isAPActor, isAPFollow, isAPNote, isAPUndo, toIdArray, toStringValue } from '../utils.js';
import { instanceV1, instanceV2 } from './instanceInformation.js';
import { oauth } from './oauth.js';
import type { PageParams } from './pagination.js';
import {
	buildLinkHeader,
	isAscending,
	isIdInRange,
	lowerBoundId,
	parsePageParams,
	takePage,
} from './pagination.js';
import {
	noteToCounts,
	noteToEditedAt,
	noteToEmojis,
	noteToHashtags,
	noteToLanguage,
	noteToMentions,
	noteToVisibility,
	isNotePublicTimelineEligible,
	isNoteVisibleTo,
} from './statusAttributes.js';

const validScopes = [
	'follow',
	'push',
	'read',
	'read:accounts',
	'read:blocks',
	'read:blocks',
	'read:bookmarks',
	'read:favourites',
	'read:filters',
	'read:follows',
	'read:follows',
	'read:lists',
	'read:mutes',
	'read:mutes',
	'read:notifications',
	'read:search',
	'read:statuses',
	'write',
	'write:accounts',
	'write:blocks',
	'write:blocks',
	'write:bookmarks',
	'write:conversations',
	'write:favourites',
	'write:filters',
	'write:follows',
	'write:follows',
	'write:lists',
	'write:media',
	'write:mutes',
	'write:mutes',
	'write:notifications',
	'write:reports',
	'write:statuses',
];

const assertIsAPActor: (
	object: ApexObject | undefined,
) => asserts object is ApexObject & APActor = (object) => {
	assert(object !== undefined, 'object is undefined');
	assert(isAPActor(object), `object is not an actor: ${object.id}`);
};

const externalUserInfo: UserInfo = {
	bot: false,
	created_at: '2021-01-01T00:00:00.000Z',
	emojis: [],
	fields: [],
	followers_count: 0,
	following_count: 0,
	id: '1',
	last_status_at: '',
	locked: false,
	roles: [],
	statuses_count: 0,
	uid: null,
};

export const actorObjectToAccount = async (
	actorObject: APActor,
	userInfo: UserInfo = externalUserInfo,
): Promise<CamelToSnake<mastodon.v1.Account>> => {
	// activitypub-types の APActor は icon/image を IconField|ImageField の union として定義するなど
	// ここでの緩いプロパティアクセスと厳密には一致しない。この不整合の解消は ADR-0022 の対象外
	// (apex 自体の型付けのみが対象) なので、ここでは toJSONLD 呼び出し以前と同じ緩さを維持する。
	const actor = await apex.toJSONLD<JsonLdActor>(actorObject);
	const username = actor.preferredUsername ?? last(actor.id.split('/')) ?? '';
	const actorDomain = new URL(actor.id).host;

	return {
		...userInfo,
		username,
		acct: `${username}@${actorDomain}`,
		display_name: actor.name ?? '',
		url: `https://elk.zone/${mastodonDomain}/@${username}@${domain}`,
		avatar: actor.icon?.url ?? '',
		avatar_static: actor.icon?.url ?? '',
		header: actor.image?.url ?? '',
		header_static: actor.image?.url ?? '',
		note: actor.summary ?? '',
		discoverable: actor.discoverable ?? false,
	};
};

const actorUsernameToAccount = async (
	username: string,
): Promise<CamelToSnake<mastodon.v1.Account> | undefined> => {
	const actorId = `https://${domain}/activitypub/u/${username}`;
	const [object, userInfoDoc] = await Promise.all([
		apex.store.getObject(actorId),
		UserInfos.doc(escapeFirestoreKey(actorId)).get(),
	]);
	if (object === undefined || !userInfoDoc.exists) {
		return undefined;
	}
	assertIsAPActor(object);
	const userInfo = userInfoDoc.data();
	assert(userInfo !== undefined, 'userInfo is undefined');
	return actorObjectToAccount(object, userInfo);
};

// `id` には AP IRI ではなく、時系列順に採番した Mastodon ID を渡す (→ ADR-0006、ADR-0058)。
// 取得は `getMastodonIds` で行う。
// Status の各属性は Note の実データから導出する (→ ADR-0060)。
export interface StatusContext {
	// 投稿者の followers コレクションの IRI。可視性の判定に使う。
	followersIri?: string;
	// リプライ先の Mastodon ID とその投稿者のアカウント ID。解決できなければ未指定。
	inReplyTo?: { id: string; accountId: string } | undefined;
	// `_meta` の非正規化カウンタ (→ ADR-0037)。
	meta?: { likesCount?: number; sharesCount?: number } | undefined;
}

// masto の型は `application` を non-null としているが、Mastodon 本体はリモート投稿で null を返す。
export type StatusEntity = Omit<CamelToSnake<mastodon.v1.Status>, 'application'> & {
	application: CamelToSnake<mastodon.v1.Status>['application'] | null;
};

const isLocalIri = (iri: string) => iri.startsWith(`https://${domain}/`);

// oxlint-disable-next-line max-params -- 属性の導出元 (note/account/id) と外部参照の文脈を別引数に保つ
export const noteObjectToStatus = (
	note: APNote,
	account: CamelToSnake<mastodon.v1.Account>,
	id: string,
	context: StatusContext = {},
): StatusEntity => {
	assert(note.id !== undefined, 'note.id is undefined');
	assert(note.published !== undefined, 'note.published is undefined');
	const noteId = note.id;
	return {
		id,
		created_at: note.published.toString(),
		edited_at: noteToEditedAt(note),
		in_reply_to_id: context.inReplyTo?.id ?? null,
		in_reply_to_account_id: context.inReplyTo?.accountId ?? null,
		sensitive: (note as { sensitive?: unknown }).sensitive === true,
		spoiler_text: toStringValue(note.summary) ?? '',
		visibility: noteToVisibility(note, context.followersIri),
		language: noteToLanguage(note),
		// Mastodon の `uri` は連合で使う ActivityPub の IRI。
		uri: noteId,
		// `url` は人間向けの URL。Note の `url` があればそれ、無ければ IRI。
		url: toIdArray(note.url)[0] ?? noteId,
		...noteToCounts(note, context.meta),
		reblogged: false,
		favourited: false,
		muted: false,
		bookmarked: false,
		pinned: false,
		content: toStringValue(note.content) ?? '',
		reblog: null,
		// application はこのサーバーの投稿のみ。リモート投稿では不明なので null。
		application: isLocalIri(noteId)
			? {
					name: 'activitypub-firebase',
					website: `https://${domain}`,
				}
			: null,
		account,
		// メディアは Phase 4 (メディア) で実装するまで空配列のままにする。
		media_attachments: [],
		mentions: noteToMentions(note),
		tags: noteToHashtags(note),
		emojis: noteToEmojis(note),
		card: null,
		poll: null,
	};
};

const getAttributedTo = (object: APObject): string | undefined => toIdArray(object.attributedTo)[0];

const userIdsToAcconts = async (
	userIds: string[],
): Promise<CamelToSnake<mastodon.v1.Account>[]> => {
	if (userIds.length === 0) {
		return [];
	}

	const [actorObjects, userInfoDocsChunks] = await Promise.all([
		apex.store.getObjects(userIds),
		Promise.all(
			chunk(userIds.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT).map((idChunk) =>
				UserInfos.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
			),
		),
	]);

	const actorMap = new Map<string, APActor>(
		actorObjects.map((actor) => {
			assertIsAPActor(actor);
			return [actor.id, actor];
		}),
	);
	const userInfoMap = new Map<string, UserInfo>(
		userInfoDocsChunks.flatMap((userInfos) =>
			userInfos.docs.map(
				(doc) => [unescapeFirestoreKey(toFirestoreKey(doc.id)), doc.data()] as const,
			),
		),
	);

	return Promise.all(
		userIds.map((userId) => {
			const actor = actorMap.get(userId);
			assert(actor !== undefined, 'actor is undefined');

			const userInfo = userInfoMap.get(userId);

			return actorObjectToAccount(actor, userInfo);
		}),
	);
};

// Note を Status エンティティへ変換する。可視性の絞り込みは呼び出し側で済ませておくこと。
type NoteObject = ApexObject & APNote;

const notesToStatuses = async (notes: NoteObject[]) => {
	const validNotes = notes.filter((note) => getAttributedTo(note) !== undefined);

	// リプライ先は手元に保存済みのものだけ解決する (リモートへは取りに行かない → ADR-0059)。
	const replyTargetIris = uniq(validNotes.flatMap((note) => toIdArray(note.inReplyTo).slice(0, 1)));
	const replyTargets = (await apex.store.getObjects(replyTargetIris)).filter(isAPNote);
	const replyTargetMap = new Map(replyTargets.map((target) => [target.id, target]));

	const authorIris = uniq([
		...validNotes.map((note) => getAttributedTo(note)),
		...replyTargets.map((target) => getAttributedTo(target)),
	]).filter((iri): iri is string => iri !== undefined);
	const [accounts, mastodonIds] = await Promise.all([
		userIdsToAcconts(authorIris),
		getMastodonIds(
			[...validNotes, ...replyTargets].map((note) => ({ iri: note.id, published: note.published })),
		),
	]);
	const accountsMap = new Map(zip(authorIris, accounts));

	return validNotes.map((note) => {
		const attributedTo = getAttributedTo(note);
		assert(attributedTo !== undefined, 'attributedTo is undefined');

		const account = accountsMap.get(attributedTo);
		assert(account !== undefined, 'account is undefined');

		const mastodonId = mastodonIds.get(note.id);
		assert(mastodonId !== undefined, 'mastodonId is undefined');

		const replyTarget = replyTargetMap.get(toIdArray(note.inReplyTo)[0] ?? '');
		const replyTargetAuthor = replyTarget && getAttributedTo(replyTarget);
		const replyTargetId = replyTarget && mastodonIds.get(replyTarget.id);
		const replyTargetAccount = replyTargetAuthor ? accountsMap.get(replyTargetAuthor) : undefined;
		const inReplyTo =
			replyTargetId !== undefined && replyTargetAccount !== undefined
				? { id: replyTargetId, accountId: replyTargetAccount.id }
				: undefined;

		return noteObjectToStatus(note, account, mastodonId, { inReplyTo, meta: note._meta });
	});
};

const getInboxId = (actor: APActor) => {
	const inboxId = toIdArray(actor.inbox)[0];
	if (inboxId !== undefined) {
		return inboxId;
	}
	throw new Error('inbox is not string');
};

const STATUS_PAGE_LIMITS = { defaultLimit: 20, maxLimit: 40 };
const FOLLOWERS_PAGE_LIMITS = { defaultLimit: 40, maxLimit: 80 };
// 可視性で落ちる分を見込んで、1回の Firestore クエリではこの倍数だけ多めに読む。
const TIMELINE_FETCH_FACTOR = 3;
// 小さい limit でも読み足しラウンドを使い切って空ページになりにくいよう、1回に読む件数の下限を設ける。
const MIN_TIMELINE_FETCH_SIZE = 100;
const MAX_TIMELINE_FETCH_ROUNDS = 10;
// ID のタイムスタンプから求めた published の範囲に持たせる余裕。published の表記揺れ
// (ミリ秒の有無など) で境界の Note を取りこぼさないよう広めに読み、ID で厳密に比較し直す (→ ADR-0062)。
const ID_BOUND_MARGIN_MS = 1000;

const idToPublishedBound = (id: string, offsetMs: number) =>
	new Date(mastodonIdToTimestamp(id) + offsetMs).toISOString();

interface PagedNote {
	id: string;
	note: NoteObject;
}

// viewer がフォロー中 (相手が Accept 済み) の actor IRI を返す。
export const getFollowing = async (actor: APActor): Promise<string[]> => {
	assert(actor.id !== undefined, 'actor.id is undefined');
	const actorKey = escapeFirestoreKey(actor.id);

	const followStreams = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('actors', actorKey), '==', true)
		.get();
	if (followStreams.empty) {
		return [];
	}
	const acceptStreams = await Streams.where(
		metaIndexPath('collections', escapeFirestoreKey(getInboxId(actor))),
		'==',
		true,
	)
		.where('type', '==', 'Accept')
		.get();
	const acceptedFollowIds = new Set(
		acceptStreams.docs.flatMap((doc) => toIdArray(doc.data().object)),
	);

	return uniq(
		followStreams.docs.flatMap((doc) => {
			const follow = doc.data();
			const target = toIdArray(follow.object)[0];
			return target !== undefined && acceptedFollowIds.has(follow.id) ? [target] : [];
		}),
	);
};

// `page` のカーソルに沿って Note を読み、`isVisible` を通ったものを limit 件集めて新しい順に返す。
// 可視性の判定は Firestore のクエリでは表現できないため、足りなければカーソルを進めて読み足す。
const collectVisibleNotes = async ({
	actors,
	page,
	isVisible,
}: {
	actors?: string[] | undefined;
	page: PageParams;
	isVisible: (note: NoteObject) => boolean;
}): Promise<PagedNote[]> => {
	const ascending = isAscending(page);
	const lowerId = lowerBoundId(page);
	const lower =
		lowerId === undefined ? undefined : idToPublishedBound(lowerId, -ID_BOUND_MARGIN_MS);
	const upper =
		page.maxId === undefined ? undefined : idToPublishedBound(page.maxId, ID_BOUND_MARGIN_MS);
	const fetchSize = Math.max(page.limit * TIMELINE_FETCH_FACTOR, MIN_TIMELINE_FETCH_SIZE);

	const collected: PagedNote[] = [];
	let cursor: string | undefined;
	for (let round = 0; round < MAX_TIMELINE_FETCH_ROUNDS && collected.length < page.limit; round++) {
		const rows = await apex.store.getNotes({
			actors,
			limit: fetchSize,
			order: ascending ? 'asc' : 'desc',
			lower,
			upper,
			cursor,
		});
		const visible = rows
			.filter(isAPNote)
			.filter((note) => getAttributedTo(note) !== undefined && isVisible(note));
		const ids = await getMastodonIds(
			visible.map((note) => ({ iri: note.id, published: note.published })),
		);
		for (const note of visible) {
			const id = ids.get(note.id);
			if (id !== undefined && isIdInRange(id, page)) {
				collected.push({ id, note });
			}
		}
		const lastPublished = rows.at(-1)?.published;
		if (rows.length < fetchSize || lastPublished === undefined) {
			break;
		}
		cursor = String(lastPublished);
	}
	return takePage(collected, (entry) => entry.id, page);
};

// actor の投稿一覧。viewer に見えるものだけを返す。
export const getAccountStatuses = async (
	actorId: string,
	viewer: APActor | undefined,
	page: PageParams,
) => {
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	const notes = await collectVisibleNotes({
		actors: [actorId],
		page,
		isVisible: (note) => isNoteVisibleTo(note, viewer?.id, viewerFollowing),
	});
	return notesToStatuses(notes.map((entry) => entry.note));
};

// 公開タイムライン。public な投稿のみ (unlisted / private / direct は載せない)。
export const getPublicTimeline = async (page: PageParams) => {
	const notes = await collectVisibleNotes({ page, isVisible: isNotePublicTimelineEligible });
	return notesToStatuses(notes.map((entry) => entry.note));
};

// ホームタイムライン。自分の投稿 + フォロー中の相手の投稿のうち、閲覧権限のあるもの。
export const getHomeTimeline = async (viewer: APActor, page: PageParams) => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');
	const viewerFollowing = new Set(await getFollowing(viewer));
	const authors = [viewer.id, ...viewerFollowing];
	const entries = (
		await Promise.all(
			chunk(authors, FIRESTORE_IN_QUERY_LIMIT).map((actors) =>
				collectVisibleNotes({
					actors,
					page,
					isVisible: (note) => isNoteVisibleTo(note, viewer.id, viewerFollowing),
				}),
			),
		)
	).flat();
	return notesToStatuses(takePage(entries, (entry) => entry.id, page).map((entry) => entry.note));
};

// カーソルは Follow アクティビティの Mastodon ID (Mastodon の follow 行 ID に相当。→ ADR-0062)。
// 返す `cursorIds` は `accounts` と同じ並び (新しい順)。
export const getFollowersPage = async (
	actor: APActor,
	page: PageParams = { limit: FOLLOWERS_PAGE_LIMITS.defaultLimit },
) => {
	assert(actor.id !== undefined, 'actor.id is undefined');

	// object/actor は IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうるため、生の
	// フィールドではなく denormalizations.ts が書き込む map 形式のインデックス `_meta.index.*`
	// を等価条件で引く(→ ADR-0021)。
	const followStreams = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('objects', escapeFirestoreKey(actor.id)), '==', true)
		.get();
	// 受信した Undo の object は、Mastodon のように Follow を丸ごと埋め込んでくる場合と
	// 素の IRI 文字列で届く場合がある。`_meta.objectType` による絞り込みは後者を取りこぼすため、
	// inbox の Undo をすべて取得し、打ち消された Follow の IRI で突き合わせる(→ ADR-0021)。
	const unfollowStreams = await Streams.where(
		metaIndexPath('collections', escapeFirestoreKey(getInboxId(actor))),
		'==',
		true,
	)
		.where('type', '==', 'Undo')
		.get();

	const undoneFollowIds = new Set(
		unfollowStreams.docs.flatMap((unfollowStream) => {
			const unfollow = unfollowStream.data();
			if (!isAPUndo(unfollow)) {
				return [];
			}
			return toIdArray(unfollow.object);
		}),
	);

	const followers = new Map<string, { followIri: string; published: unknown }>();

	for (const followStream of followStreams.docs) {
		const follow = followStream.data();
		if (undoneFollowIds.has(follow.id) || !isAPFollow(follow)) {
			continue;
		}
		const followActor = toIdArray(follow.actor)[0];
		if (followActor !== undefined && !followers.has(followActor)) {
			followers.set(followActor, { followIri: follow.id, published: follow.published });
		}
	}

	const followIds = await getMastodonIds(
		Array.from(followers.values(), ({ followIri, published }) => ({ iri: followIri, published })),
	);
	const entries = Array.from(followers, ([actorIri, { followIri }]) => ({
		actorIri,
		cursorId: followIds.get(followIri),
	})).filter(
		(entry): entry is { actorIri: string; cursorId: string } =>
			entry.cursorId !== undefined && isIdInRange(entry.cursorId, page),
	);
	const pageEntries = takePage(entries, (entry) => entry.cursorId, page);

	return {
		accounts: await userIdsToAcconts(pageEntries.map((entry) => entry.actorIri)),
		cursorIds: pageEntries.map((entry) => entry.cursorId),
	};
};

export const getFollowers = async (actor: APActor, page?: PageParams) =>
	(await getFollowersPage(actor, page)).accounts;

// OAuth トークンから、ログイン中のローカル actor の IRI と UserInfo を引く。
const resolveAuth = async (req: express.Request, res: express.Response) => {
	const request = new OauthRequest(req);
	const response = new OauthResponse(res);
	const token = await oauth.authenticate(request, response);

	const uid = token.user?.userId;
	assert(typeof uid === 'string');

	const userInfoDocs = await UserInfos.where('uid', '==', uid).get();
	assert(!userInfoDocs.empty);
	assert(userInfoDocs.size === 1);

	const userInfoDoc = userInfoDocs.docs[0];
	assert(userInfoDoc !== undefined);

	return {
		userInfo: userInfoDoc.data(),
		actorId: unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id)),
	};
};

const authRequired = async (
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) => {
	const { userInfo, actorId } = await resolveAuth(req, res);
	// eslint-disable-next-line require-atomic-updates
	res.locals.auth = userInfo;
	// eslint-disable-next-line require-atomic-updates
	res.locals.actorId = actorId;

	next();
};

const getLocalActor = async (actorId: string): Promise<APActor> => {
	const actor = await apex.store.getObject(actorId);
	assert(actor !== undefined, 'actor is undefined');
	assertIsAPActor(actor);
	return actor;
};

// 認証は任意のエンドポイント用。トークンが無い・無効なら未認証の閲覧者として扱う。
const getOptionalViewer = async (
	req: express.Request,
	res: express.Response,
): Promise<APActor | undefined> => {
	if (req.headers.authorization === undefined) {
		return undefined;
	}
	try {
		const { actorId } = await resolveAuth(req, res);
		return await getLocalActor(actorId);
	} catch {
		return undefined;
	}
};

const getAccount = (acct: string) => {
	const [username, lookupDomain = domain] = acct.split('@');

	if (username === undefined) {
		return undefined;
	}

	if (lookupDomain !== domain) {
		throw new Error('Not implemented');
	}

	return actorUsernameToAccount(username);
};

// 絶対 URL の Link ヘッダを組み立てて付ける。`ids` は応答の並び (新しい順)。
const setLinkHeader = (req: express.Request, res: express.Response, ids: string[]) => {
	const link = buildLinkHeader(
		`https://${mastodonDomain}${req.baseUrl}${req.path}`,
		req.query,
		ids,
	);
	if (link !== undefined) {
		res.set('Link', link);
	}
};

const respondWithStatuses = (
	req: express.Request,
	res: express.Response,
	statuses: StatusEntity[],
) => {
	setLinkHeader(
		req,
		res,
		statuses.map((status) => status.id),
	);
	res.json(statuses);
};

const router = express.Router();

router.use(
	'/',
	cors({
		origin: true,
		methods: ['GET', 'POST'],
		allowedHeaders: ['Authorization', 'Content-Type'],
		// これがないとブラウザ上のクライアントが Link ヘッダを読めずページネーションできない。
		exposedHeaders: ['Link'],
	}),
);

router.get('/v1/instance', (req, res) => {
	res.json(instanceV1);
});

router.get('/v2/instance', (req, res) => {
	res.json(instanceV2);
});

router.get('/v1/custom_emojis', (req, res) => {
	res.json([]);
});

export const accountLookupQuerySchema = z.object({
	acct: z.string().min(1),
});

export const accountParamsSchema = z.object({
	id: z.string().min(1),
});

export const createAppBodySchema = z.object({
	client_name: z.string().min(1),
	redirect_uris: z.string().min(1),
	scopes: z
		.string()
		.default('read')
		.refine((scopes) => scopes.split(' ').every((scope) => validScopes.includes(scope)), {
			message: 'Invalid scope included',
		}),
	website: z.string().default(''),
});

router.get('/v1/accounts/lookup', async (req, res) => {
	const parsedQuery = accountLookupQuerySchema.safeParse(req.query);
	if (!parsedQuery.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const account = await getAccount(parsedQuery.data.acct);

	if (account === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	res.json(account);
});

router.get('/v1/accounts/:id/statuses', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfo = await UserInfos.where('id', '==', parsedParams.data.id).get();
	const userInfoDoc = userInfo.docs[0];
	if (userInfoDoc === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}
	const actorId = unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id));

	// 認証は任意。トークンがあれば閲覧者として可視性を判定する。
	const viewer = await getOptionalViewer(req, res);
	respondWithStatuses(
		req,
		res,
		await getAccountStatuses(actorId, viewer, parsePageParams(req.query, STATUS_PAGE_LIMITS)),
	);
});

router.get('/v1/accounts/:id/followers', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfo = await UserInfos.where('id', '==', parsedParams.data.id).get();

	if (userInfo.docs.length !== 1) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfoDoc = userInfo.docs[0];
	assert(userInfoDoc !== undefined);

	const userId = unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id));
	const actorObject = await apex.store.getObject(userId);

	if (actorObject === undefined) {
		res.sendStatus(500);
		return;
	}
	assertIsAPActor(actorObject);

	const { accounts, cursorIds } = await getFollowersPage(
		actorObject,
		parsePageParams(req.query, FOLLOWERS_PAGE_LIMITS),
	);
	setLinkHeader(req, res, cursorIds);
	res.json(accounts);
});

router.get('/v1/accounts/verify_credentials', authRequired, (req, res) => {
	res.json(res.locals.auth);
});

router.get('/v1/preferences', authRequired, (req, res) => {
	res.send({
		'posting:default:visibility': 'public',
		'posting:default:sensitive': false,
		'posting:default:language': 'ja',
		'reading:expand:media': 'show_all',
		'reading:expand:spoilers': true,
	});
});

router.get('/v1/push/subscription', authRequired, (req, res) => {
	res.status(404).json({
		error: 'Record not found',
	});
});

router.get('/v1/timelines/public', async (req, res) => {
	respondWithStatuses(
		req,
		res,
		await getPublicTimeline(parsePageParams(req.query, STATUS_PAGE_LIMITS)),
	);
});

router.get('/v1/timelines/home', authRequired, async (req, res) => {
	const viewer = await getLocalActor(res.locals.actorId as string);
	respondWithStatuses(
		req,
		res,
		await getHomeTimeline(viewer, parsePageParams(req.query, STATUS_PAGE_LIMITS)),
	);
});

router.post('/v1/apps', async (req, res) => {
	const parsedBody = createAppBodySchema.safeParse(req.body);
	if (!parsedBody.success) {
		res.status(400).send('Bad request');
		return;
	}

	const { client_name: clientName, redirect_uris: redirectUris, scopes, website } = parsedBody.data;

	const scopeSet = new Set<string>(scopes.split(' '));

	const id = (await Clients.count().get()).data().count + 1;
	const clientId = crypto.randomBytes(32).toString('hex');
	const clientSecret = crypto.randomBytes(32).toString('hex');
	const vapidKey = crypto.randomBytes(32).toString('hex');

	await Clients.add({
		id: id.toString(),
		name: clientName,
		redirectUris,
		grants: ['authorization_code', 'refresh_token'],
		clientId,
		clientSecret,
		scopes: Array.from(scopeSet),
		vapidKey,
	});

	res.json({
		id: id.toString(),
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirectUris,
		name: clientName,
		website,
		vapid_key: vapidKey,
	});
});

// fallback all /api routes to 501
router.use('/', (req, res) => {
	res.status(501).send('Not implemented');
});

export default router;
