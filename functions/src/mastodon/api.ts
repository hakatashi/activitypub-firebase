import assert from 'node:assert';
import crypto from 'node:crypto';
import { Request as OauthRequest, Response as OauthResponse } from '@node-oauth/oauth2-server';
import type { APObject as ApexObject, JsonLdActor } from '../apex/index.js';
import type { APNote, APActor, APObject } from 'activitypub-types';
import cors from 'cors';
import express from 'express';
import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { chunk, last, uniq, zip } from 'lodash-es';
import type { mastodon } from 'masto';
import { z } from 'zod';
import { apex } from '../activitypub.js';
import {
	db,
	domain,
	escapeFirestoreKey,
	mastodonDomain,
	toFirestoreKey,
	unescapeFirestoreKey,
} from '../firebase.js';
import { reserveIdempotencyKey } from '../idempotency.js';
import { getIriByMastodonId, getMastodonIds, mastodonIdToTimestamp } from '../mastodonId.js';
import { metaIndexPath } from '../meta.js';
import { deleteNote, htmlToPlainText, plainTextToHtml, publishNote } from '../notes.js';
import { Clients, Markers, Streams, UserInfo, UserInfos } from '../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../store.js';
import type { CamelToSnake } from '../utils.js';
import {
	isAPActor,
	isAPFollow,
	isAPNote,
	isAPUndo,
	toError,
	toIdArray,
	toStringValue,
} from '../utils.js';
import { getInstanceV1, getInstanceV2, instanceV2 } from './instanceInformation.js';
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
	const isLocal = actorDomain === domain;

	return {
		...userInfo,
		username,
		acct: isLocal ? username : `${username}@${actorDomain}`,
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

export interface CredentialAccountSource {
	privacy: string;
	sensitive: boolean;
	language: string;
	note: string;
	fields: CamelToSnake<mastodon.v1.AccountField>[];
	follow_requests_count: number;
}

export interface RoleEntity {
	id: string;
	name: string;
	permissions: string;
	color: string;
	highlighted: boolean;
}

export type CredentialAccountEntity = CamelToSnake<mastodon.v1.Account> & {
	source: CredentialAccountSource;
	role: RoleEntity;
};

export const defaultRole: RoleEntity = {
	id: '-99',
	name: '',
	permissions: '0',
	color: '',
	highlighted: false,
};

export const accountToCredentialAccount = (
	account: CamelToSnake<mastodon.v1.Account>,
	userInfo: UserInfo,
): CredentialAccountEntity => ({
	...account,
	source: {
		privacy: 'public',
		sensitive: false,
		language: 'ja',
		note: htmlToPlainText(account.note),
		fields: userInfo.fields ?? [],
		follow_requests_count: 0,
	},
	role: defaultRole,
});

export type RelationshipEntity = CamelToSnake<mastodon.v1.Relationship> & {
	muting_expires_at?: string | null;
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
// また DELETE レスポンスでは本文プレーンテキストの `text` が含まれる。
export type StatusEntity = Omit<CamelToSnake<mastodon.v1.Status>, 'application'> & {
	application: CamelToSnake<mastodon.v1.Status>['application'] | null;
	text?: string | null;
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
// ID のタイムスタンプ部は `_meta.published` (→ ADR-0062) と同じ規則で決まるので、そのまま範囲の端にできる。
const idToPublishedBound = (id: string) => new Date(mastodonIdToTimestamp(id)).toISOString();

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
	const lower = lowerId === undefined ? undefined : idToPublishedBound(lowerId);
	const upper = page.maxId === undefined ? undefined : idToPublishedBound(page.maxId);
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
		const lastPublished = rows.at(-1)?._meta?.published;
		if (rows.length < fetchSize || lastPublished === undefined) {
			break;
		}
		cursor = lastPublished;
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

export const getFollowerActorIris = async (actor: APActor): Promise<string[]> => {
	assert(actor.id !== undefined, 'actor.id is undefined');

	const followStreams = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('objects', escapeFirestoreKey(actor.id)), '==', true)
		.get();
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

	const followerIris: string[] = [];
	for (const followStream of followStreams.docs) {
		const follow = followStream.data();
		if (undoneFollowIds.has(follow.id) || !isAPFollow(follow)) {
			continue;
		}
		const followActor = toIdArray(follow.actor)[0];
		if (followActor !== undefined && !followerIris.includes(followActor)) {
			followerIris.push(followActor);
		}
	}
	return followerIris;
};

export const getPendingFollowTargetIris = async (actor: APActor): Promise<Set<string>> => {
	assert(actor.id !== undefined, 'actor.id is undefined');
	const actorKey = escapeFirestoreKey(actor.id);

	const followStreams = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('actors', actorKey), '==', true)
		.get();
	if (followStreams.empty) {
		return new Set();
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

	const undoStreams = await Streams.where('type', '==', 'Undo')
		.where(metaIndexPath('actors', actorKey), '==', true)
		.get();
	const undoneFollowIds = new Set(undoStreams.docs.flatMap((doc) => toIdArray(doc.data().object)));

	const pendingTargetIris = new Set<string>();
	for (const doc of followStreams.docs) {
		const follow = doc.data();
		if (!isAPFollow(follow)) {
			continue;
		}
		if (acceptedFollowIds.has(follow.id) || undoneFollowIds.has(follow.id)) {
			continue;
		}
		const target = toIdArray(follow.object)[0];
		if (target !== undefined) {
			pendingTargetIris.add(target);
		}
	}
	return pendingTargetIris;
};

// カーソルは Follow アクティビティの Mastodon ID (→ ADR-0062)。
// 返す `cursorIds` は `accounts` と同じ並び (新しい順)。
export const getFollowingPage = async (
	actor: APActor,
	page: PageParams = { limit: FOLLOWERS_PAGE_LIMITS.defaultLimit },
) => {
	assert(actor.id !== undefined, 'actor.id is undefined');
	const actorKey = escapeFirestoreKey(actor.id);

	const followStreams = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('actors', actorKey), '==', true)
		.get();
	if (followStreams.empty) {
		return { accounts: [], cursorIds: [] };
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

	const undoStreams = await Streams.where('type', '==', 'Undo')
		.where(metaIndexPath('actors', actorKey), '==', true)
		.get();
	const undoneFollowIds = new Set(undoStreams.docs.flatMap((doc) => toIdArray(doc.data().object)));

	const following = new Map<string, { followIri: string; published: unknown }>();

	for (const followStream of followStreams.docs) {
		const follow = followStream.data();
		if (!isAPFollow(follow)) {
			continue;
		}
		if (undoneFollowIds.has(follow.id) || !acceptedFollowIds.has(follow.id)) {
			continue;
		}
		const target = toIdArray(follow.object)[0];
		if (target !== undefined && !following.has(target)) {
			following.set(target, { followIri: follow.id, published: follow.published });
		}
	}

	const followIds = await getMastodonIds(
		Array.from(following.values(), ({ followIri, published }) => ({ iri: followIri, published })),
	);
	const entries = Array.from(following, ([actorIri, { followIri }]) => ({
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

export const getRelationships = async (
	viewer: APActor,
	accountIds: string[],
): Promise<RelationshipEntity[]> => {
	if (accountIds.length === 0) {
		return [];
	}

	const userInfoDocsChunks = await Promise.all(
		chunk(accountIds, FIRESTORE_IN_QUERY_LIMIT).map((chunkIds) =>
			UserInfos.where('id', 'in', chunkIds).get(),
		),
	);
	const targetActorMap = new Map<string, string>();
	for (const chunkSnap of userInfoDocsChunks) {
		for (const doc of chunkSnap.docs) {
			const data = doc.data();
			const actorId = unescapeFirestoreKey(toFirestoreKey(doc.id));
			targetActorMap.set(data.id, actorId);
		}
	}
	for (const id of accountIds) {
		if (!targetActorMap.has(id)) {
			const iri = await getIriByMastodonId(id);
			if (iri !== undefined) {
				targetActorMap.set(id, iri);
			}
		}
	}

	const [followingList, followerList, pendingSet] = await Promise.all([
		getFollowing(viewer),
		getFollowerActorIris(viewer),
		getPendingFollowTargetIris(viewer),
	]);
	const followingSet = new Set(followingList);
	const followerSet = new Set(followerList);

	const results: RelationshipEntity[] = [];
	for (const id of accountIds) {
		const targetActorId = targetActorMap.get(id);
		if (targetActorId === undefined) {
			continue;
		}
		const isFollowing = followingSet.has(targetActorId);
		results.push({
			id,
			following: isFollowing,
			showing_reblogs: isFollowing,
			notifying: false,
			languages: [],
			followed_by: followerSet.has(targetActorId),
			blocking: false,
			blocked_by: false,
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
			requested: pendingSet.has(targetActorId),
			requested_by: false,
			domain_blocking: false,
			endorsed: false,
			note: '',
		});
	}

	return results;
};

const resolveAccountActor = async (
	id: string,
): Promise<{ actor: ApexObject & APActor; userInfo?: UserInfo } | undefined> => {
	const userInfoSnap = await UserInfos.where('id', '==', id).get();
	const userInfoDoc = userInfoSnap.docs[0];
	if (userInfoDoc !== undefined) {
		const actorId = unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id));
		const actor = await apex.store.getObject(actorId);
		if (actor === undefined) {
			return undefined;
		}
		assertIsAPActor(actor);
		return { actor, userInfo: userInfoDoc.data() };
	}

	const iri = await getIriByMastodonId(id);
	if (iri !== undefined) {
		const object = await apex.store.getObject(iri);
		if (object !== undefined && isAPActor(object)) {
			assertIsAPActor(object);
			return { actor: object };
		}
	}

	return undefined;
};

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
		scope: token.scope,
	};
};

const authRequired = async (
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) => {
	try {
		const { userInfo, actorId, scope } = await resolveAuth(req, res);
		// eslint-disable-next-line require-atomic-updates
		res.locals.auth = userInfo;
		// eslint-disable-next-line require-atomic-updates
		res.locals.actorId = actorId;
		// eslint-disable-next-line require-atomic-updates
		res.locals.scope = scope;

		next();
	} catch (error) {
		const status = (error as { statusCode?: number }).statusCode ?? 401;
		res.status(status).json({
			error: toError(error).message,
		});
	}
};

// Mastodon と同じく、`write:statuses` のような細分化スコープはその親 (`write`) でも満たされる。
export const hasScope = (granted: unknown, required: string) => {
	const grantedScopes = (
		Array.isArray(granted) ? granted : String(granted ?? '').split(' ')
	).filter((scope): scope is string => typeof scope === 'string');
	const parent = required.split(':')[0];
	return grantedScopes.some((scope) => scope === required || scope === parent);
};

// `authRequired` の後に置く。
const scopeRequired =
	(required: string) =>
	(req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (!hasScope(res.locals.scope, required)) {
			res.status(403).json({
				error: 'This action is outside the authorized scopes',
			});
			return;
		}
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
		return undefined;
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

// Mastodon の `ActiveModel::Type::Boolean` に合わせ、フォーム由来の文字列も解釈する。
const FALSE_VALUES = new Set(['0', 'f', 'false', 'off']);
export const toBoolean = (value: boolean | string | null | undefined) => {
	if (typeof value === 'boolean') {
		return value;
	}
	if (value === null || value === undefined || value === '') {
		return undefined;
	}
	return !FALSE_VALUES.has(value.toLowerCase());
};

const isPresent = (value: unknown) => {
	if (value === undefined || value === null || value === '') {
		return false;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (typeof value === 'object') {
		return Object.keys(value).length > 0;
	}
	return true;
};

const unprocessable = (res: express.Response, error: string) => {
	res.status(422).json({ error });
};

const router = express.Router();

router.use(
	'/',
	cors({
		origin: true,
		methods: ['GET', 'POST', 'PATCH', 'DELETE'],
		allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
		// これがないとブラウザ上のクライアントが Link ヘッダを読めずページネーションできない。
		exposedHeaders: ['Link'],
	}),
);

router.get('/v1/instance', async (req, res) => {
	res.json(await getInstanceV1());
});

router.get('/v2/instance', async (req, res) => {
	res.json(await getInstanceV2());
});

// ストリーミング API は提供しない (→ ADR-0007)
router.get('/v1/streaming', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

router.get('/v1/streaming/*', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

// クライアント起動用の空配列スタブ (→ ADR-0004, ADR-0067)
router.get('/v1/custom_emojis', (req, res) => {
	res.json([]);
});

router.get('/v1/filters', authRequired, scopeRequired('read:filters'), (req, res) => {
	res.json([]);
});

router.get('/v2/filters', authRequired, scopeRequired('read:filters'), (req, res) => {
	res.json([]);
});

router.get('/v1/announcements', authRequired, scopeRequired('read:statuses'), (req, res) => {
	res.json([]);
});

router.get('/v1/lists', authRequired, scopeRequired('read:lists'), (req, res) => {
	res.json([]);
});

router.get('/v1/followed_tags', authRequired, scopeRequired('read:follows'), (req, res) => {
	res.json([]);
});

router.get('/v1/conversations', authRequired, scopeRequired('read:statuses'), (req, res) => {
	res.json([]);
});

router.get('/v1/blocks', authRequired, scopeRequired('read:blocks'), (req, res) => {
	res.json([]);
});

router.get('/v1/mutes', authRequired, scopeRequired('read:mutes'), (req, res) => {
	res.json([]);
});

router.get('/v1/domain_blocks', authRequired, scopeRequired('read:blocks'), (req, res) => {
	res.json([]);
});

router.get('/v1/bookmarks', authRequired, scopeRequired('read:bookmarks'), (req, res) => {
	res.json([]);
});

router.get('/v1/favourites', authRequired, scopeRequired('read:favourites'), (req, res) => {
	res.json([]);
});

router.get('/v1/follow_requests', authRequired, scopeRequired('read:follows'), (req, res) => {
	res.json([]);
});

router.get('/v1/featured_tags', authRequired, scopeRequired('read:accounts'), (req, res) => {
	res.json([]);
});

router.get('/v1/accounts/:id/featured_tags', (req, res) => {
	res.json([]);
});

export const markersQuerySchema = z.object({
	timeline: z.union([z.string(), z.array(z.string())]).optional(),
});

export const markerTimelineSchema = z.object({
	last_read_id: z.string().min(1),
	version: z.coerce.number().int().optional(),
});

export const createMarkersBodySchema = z.object({
	home: markerTimelineSchema.optional(),
	notifications: markerTimelineSchema.optional(),
});

router.get('/v1/markers', authRequired, scopeRequired('read:statuses'), async (req, res) => {
	const parsedQuery = markersQuerySchema.safeParse(req.query);
	if (!parsedQuery.success) {
		res.status(400).send('Bad request');
		return;
	}

	const requestedTimelines = parsedQuery.data.timeline
		? (Array.isArray(parsedQuery.data.timeline)
				? parsedQuery.data.timeline
				: [parsedQuery.data.timeline]
			).filter((t): t is 'home' | 'notifications' => t === 'home' || t === 'notifications')
		: [];

	if (requestedTimelines.length === 0) {
		res.json({});
		return;
	}

	const actorId = res.locals.actorId as string;
	const docRefs = requestedTimelines.map((timeline) => ({
		timeline,
		ref: Markers.doc(toFirestoreKey(`${escapeFirestoreKey(actorId)}_${timeline}`)),
	}));

	const docs = await Promise.all(docRefs.map(({ ref }) => ref.get()));
	const result: Record<
		string,
		{
			last_read_id: string;
			version: number;
			updated_at: string;
		}
	> = {};

	for (let i = 0; i < docRefs.length; i++) {
		const item = docRefs[i]!;
		const doc = docs[i];
		if (doc && doc.exists) {
			const data = doc.data()!;
			result[item.timeline] = {
				last_read_id: data.lastReadId,
				version: data.version,
				updated_at: data.updatedAt.toDate().toISOString(),
			};
		}
	}

	res.json(result);
});

router.post('/v1/markers', authRequired, scopeRequired('write:statuses'), async (req, res) => {
	const parsedBody = createMarkersBodySchema.safeParse(req.body);
	if (!parsedBody.success) {
		res.status(400).send('Bad request');
		return;
	}

	const data = parsedBody.data;
	const timelines: ('home' | 'notifications')[] = [];
	if (data.home) {
		timelines.push('home');
	}
	if (data.notifications) {
		timelines.push('notifications');
	}

	if (timelines.length === 0) {
		res.json({});
		return;
	}

	const actorId = res.locals.actorId as string;

	try {
		const markersResult = await db.runTransaction(async (transaction) => {
			const result: Record<
				string,
				{
					last_read_id: string;
					version: number;
					updated_at: string;
				}
			> = {};

			const docRefs = timelines.map((t) => ({
				timeline: t,
				input: data[t]!,
				ref: Markers.doc(toFirestoreKey(`${escapeFirestoreKey(actorId)}_${t}`)),
			}));

			const docs = await Promise.all(docRefs.map(({ ref }) => transaction.get(ref)));

			for (let i = 0; i < docRefs.length; i++) {
				const { timeline, input, ref } = docRefs[i]!;
				const doc = docs[i];
				const now = firebase.firestore.Timestamp.now();
				if (doc && doc.exists) {
					const existing = doc.data()!;
					if (input.version !== undefined && input.version !== existing.version) {
						const error = new Error('Conflict during update, please try again');
						(error as { code?: string }).code = 'STALE_OBJECT';
						throw error;
					}
					const newVersion = existing.version + 1;
					transaction.set(ref, {
						actorId,
						timeline,
						lastReadId: input.last_read_id,
						version: newVersion,
						updatedAt: now,
					});
					result[timeline] = {
						last_read_id: input.last_read_id,
						version: newVersion,
						updated_at: now.toDate().toISOString(),
					};
				} else {
					const newVersion = 1;
					transaction.set(ref, {
						actorId,
						timeline,
						lastReadId: input.last_read_id,
						version: newVersion,
						updatedAt: now,
					});
					result[timeline] = {
						last_read_id: input.last_read_id,
						version: newVersion,
						updated_at: now.toDate().toISOString(),
					};
				}
			}
			return result;
		});

		res.json(markersResult);
	} catch (error) {
		const err = error as { code?: string | number };
		if (err.code === 'STALE_OBJECT' || err.code === 10 /* ABORTED */) {
			res.status(409).json({ error: 'Conflict during update, please try again' });
			return;
		}
		throw error;
	}
});

export const accountLookupQuerySchema = z.object({
	acct: z.string().min(1),
});

export const accountParamsSchema = z.object({
	id: z.string().min(1),
});

export const relationshipsQuerySchema = z.object({
	id: z
		.union([z.string(), z.array(z.string())])
		.transform((val) => (Array.isArray(val) ? val : [val])),
});

export const updateCredentialsBodySchema = z.object({
	display_name: z.string().optional(),
	note: z.string().optional(),
	avatar: z.unknown().optional(),
	header: z.unknown().optional(),
	locked: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
	bot: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
	discoverable: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
	fields_attributes: z
		.union([
			z.array(z.object({ name: z.string(), value: z.string() })),
			z.record(z.string(), z.object({ name: z.string(), value: z.string() })),
		])
		.optional(),
	source: z
		.object({
			privacy: z.enum(['public', 'unlisted', 'private', 'direct']).optional(),
			sensitive: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
			language: z.string().optional(),
		})
		.optional(),
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

router.get(
	'/v1/accounts/relationships',
	authRequired,
	scopeRequired('read:follows'),
	async (req, res) => {
		const parsedQuery = relationshipsQuerySchema.safeParse(req.query);
		if (!parsedQuery.success) {
			res.json([]);
			return;
		}

		const viewer = await getLocalActor(res.locals.actorId as string);
		const relationships = await getRelationships(viewer, parsedQuery.data.id);
		res.json(relationships);
	},
);

router.get('/v1/accounts/verify_credentials', authRequired, async (req, res) => {
	const actorId = res.locals.actorId as string;
	const actor = await getLocalActor(actorId);
	const userInfo = res.locals.auth as UserInfo;
	const account = await actorObjectToAccount(actor, userInfo);
	res.json(accountToCredentialAccount(account, userInfo));
});

router.patch(
	'/v1/accounts/update_credentials',
	authRequired,
	scopeRequired('write:accounts'),
	async (req, res) => {
		const parsedBody = updateCredentialsBodySchema.safeParse(req.body ?? {});
		if (!parsedBody.success) {
			unprocessable(res, `Validation failed: ${parsedBody.error.issues[0]?.message ?? 'invalid'}`);
			return;
		}
		const body = parsedBody.data;

		const actorId = res.locals.actorId as string;
		const actor = await apex.store.getObject(actorId, true);
		assertIsAPActor(actor);

		const userInfoRef = UserInfos.doc(escapeFirestoreKey(actorId));
		const userInfoDoc = await userInfoRef.get();
		assert(userInfoDoc.exists, 'userInfoDoc does not exist');
		const userUpdates: Partial<UserInfo> = {};

		if (body.display_name !== undefined) {
			actor.name = body.display_name;
		}
		if (body.note !== undefined) {
			actor.summary = plainTextToHtml(body.note);
		}
		if (body.locked !== undefined) {
			actor.manuallyApprovesFollowers = body.locked;
			userUpdates.locked = body.locked;
		}
		if (body.bot !== undefined) {
			userUpdates.bot = body.bot;
		}
		if (body.discoverable !== undefined) {
			actor.discoverable = body.discoverable;
		}
		if (body.fields_attributes !== undefined) {
			const fieldsList = Array.isArray(body.fields_attributes)
				? body.fields_attributes
				: Object.values(body.fields_attributes);
			const fields = fieldsList.map((f) => ({
				name: f.name,
				value: f.value,
				verified_at: null,
			}));
			userUpdates.fields = fields;
			actor.attachment = fields.map((f) => ({
				type: 'PropertyValue',
				name: f.name,
				value: f.value,
			}));
		}

		if (Object.keys(userUpdates).length > 0) {
			await userInfoRef.update(userUpdates);
		}

		await apex.store.saveObject(actor);

		const actorWithMeta = await apex.store.getObject(actorId, true);
		assert(actorWithMeta !== undefined, 'actorWithMeta is undefined');
		await apex.publishUpdate(actorWithMeta, actor);

		const updatedUserInfo = (await userInfoRef.get()).data();
		assert(updatedUserInfo !== undefined, 'updatedUserInfo is undefined');
		const updatedAccount = await actorObjectToAccount(actor, updatedUserInfo);
		res.json(accountToCredentialAccount(updatedAccount, updatedUserInfo));
	},
);

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

router.get('/v1/accounts/:id/following', async (req, res) => {
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

	const { accounts, cursorIds } = await getFollowingPage(
		actorObject,
		parsePageParams(req.query, FOLLOWERS_PAGE_LIMITS),
	);
	setLinkHeader(req, res, cursorIds);
	res.json(accounts);
});

router.post(
	'/v1/accounts/:id/follow',
	authRequired,
	scopeRequired('write:follows'),
	async (req, res) => {
		const parsedParams = accountParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const resolved = await resolveAccountActor(parsedParams.data.id);
		if (resolved === undefined) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const targetActor = resolved.actor;
		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		if (targetActor.id === actor.id) {
			unprocessable(res, 'You cannot follow yourself');
			return;
		}

		const followingSet = new Set(await getFollowing(actor));
		const isAlreadyFollowing = followingSet.has(targetActor.id);

		if (!isAlreadyFollowing) {
			const activity = await apex.buildActivity('Follow', actor.id, targetActor.id, {
				object: targetActor.id,
			});
			await apex.addToOutbox(actor, activity);
		}

		const isTargetLocked =
			targetActor.manuallyApprovesFollowers === true || resolved.userInfo?.locked === true;
		const followerIris = await getFollowerActorIris(actor);
		const relationship: RelationshipEntity = {
			id: parsedParams.data.id,
			following: !isTargetLocked,
			showing_reblogs: !isTargetLocked,
			notifying: false,
			languages: [],
			followed_by: followerIris.includes(targetActor.id),
			blocking: false,
			blocked_by: false,
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
			requested: isTargetLocked,
			requested_by: false,
			domain_blocking: false,
			endorsed: false,
			note: '',
		};

		res.json(relationship);
	},
);

router.post(
	'/v1/accounts/:id/unfollow',
	authRequired,
	scopeRequired('write:follows'),
	async (req, res) => {
		const parsedParams = accountParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const resolved = await resolveAccountActor(parsedParams.data.id);
		if (resolved === undefined) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const targetActor = resolved.actor;
		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		if (targetActor.id === actor.id) {
			unprocessable(res, 'You cannot unfollow yourself');
			return;
		}

		const followingIri = toIdArray(actor.following)[0];
		let follow = followingIri
			? await apex.store.findActivityByCollectionAndObjectId(followingIri, targetActor.id, true)
			: undefined;
		if (follow === undefined) {
			const outboxIri = toIdArray(actor.outbox)[0];
			if (outboxIri) {
				follow = await apex.store.findActivityByCollectionAndObjectId(
					outboxIri,
					targetActor.id,
					true,
				);
			}
		}
		if (follow === undefined) {
			const followDocs = await Streams.where('type', '==', 'Follow')
				.where('actor', 'array-contains', actor.id)
				.get();
			follow = followDocs.docs
				.map((doc) => doc.data())
				.find((act) => toIdArray(act.object).includes(targetActor.id));
		}

		if (follow !== undefined) {
			const cleanFollow = { ...follow };
			delete cleanFollow._meta;
			const undoActivity = await apex.buildActivity('Undo', actor.id, targetActor.id, {
				object: cleanFollow,
			});
			await apex.addToOutbox(actor, undoActivity);
			await apex.store.removeActivity(follow, actor.id);
		}

		const followerIris = await getFollowerActorIris(actor);
		const relationship: RelationshipEntity = {
			id: parsedParams.data.id,
			following: false,
			showing_reblogs: false,
			notifying: false,
			languages: [],
			followed_by: followerIris.includes(targetActor.id),
			blocking: false,
			blocked_by: false,
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
			requested: false,
			requested_by: false,
			domain_blocking: false,
			endorsed: false,
			note: '',
		};

		res.json(relationship);
	},
);

router.get('/v1/accounts/:id', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const resolved = await resolveAccountActor(parsedParams.data.id);
	if (resolved === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const account = await actorObjectToAccount(resolved.actor, resolved.userInfo);
	res.json({
		...account,
		id: parsedParams.data.id,
	});
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

// 作成・重複時の応答に使う。Note でなければ (まだ保存されていなければ) undefined。
const getStatusByIri = async (iri: string) => {
	const note = await apex.store.getObject(iri);
	if (!isAPNote(note)) {
		return undefined;
	}
	return (await notesToStatuses([note]))[0];
};

// JSON でもフォームでも届く。Elk は未指定の項目を `null` や空配列で送ってくる。
export const createStatusBodySchema = z.object({
	status: z.string().nullish(),
	in_reply_to_id: z.string().nullish(),
	sensitive: z.union([z.boolean(), z.string()]).nullish(),
	spoiler_text: z.string().nullish(),
	visibility: z.enum(['public', 'unlisted', 'private', 'direct']).nullish(),
	language: z.string().nullish(),
	// Phase 4 まで未対応。空でない値が来たら 422 にする (→ ADR-0063)。
	media_ids: z.unknown().optional(),
	poll: z.unknown().optional(),
	scheduled_at: z.unknown().optional(),
});

router.post('/v1/statuses', authRequired, scopeRequired('write:statuses'), async (req, res) => {
	const parsedBody = createStatusBodySchema.safeParse(req.body ?? {});
	if (!parsedBody.success) {
		unprocessable(res, `Validation failed: ${parsedBody.error.issues[0]?.message ?? 'invalid'}`);
		return;
	}
	const body = parsedBody.data;

	for (const field of ['media_ids', 'poll', 'scheduled_at'] as const) {
		if (isPresent(body[field])) {
			unprocessable(res, `${field} is not supported yet`);
			return;
		}
	}

	const spoilerText = body.spoiler_text?.trim() ?? '';
	// 本文が空で注意書きがあれば、注意書きを本文に回す (Mastodon と同じ)。
	const text = body.status?.trim() || spoilerText;
	if (text === '') {
		unprocessable(res, "Validation failed: Text can't be blank");
		return;
	}
	const maxCharacters = instanceV2.configuration.statuses.max_characters;
	if ([...text].length + [...spoilerText].length > maxCharacters) {
		unprocessable(res, `Validation failed: Text character limit of ${maxCharacters} exceeded`);
		return;
	}

	const actor = await apex.store.getObject(res.locals.actorId as string, true);
	assertIsAPActor(actor);

	let replyTarget: NoteObject | undefined;
	if (isPresent(body.in_reply_to_id)) {
		const iri = await getIriByMastodonId(body.in_reply_to_id ?? '');
		const target = iri === undefined ? undefined : await apex.store.getObject(iri);
		const visible =
			isAPNote(target) && isNoteVisibleTo(target, actor.id, new Set(await getFollowing(actor)));
		if (!visible) {
			res
				.status(404)
				.json({ error: 'The post you are trying to reply to does not appear to exist.' });
			return;
		}
		replyTarget = target;
	}

	const noteIri = apex.utils.objectIdToIRI();
	const idempotencyKey = req.get('Idempotency-Key');
	let release: (() => Promise<void>) | undefined;
	if (idempotencyKey !== undefined && idempotencyKey !== '') {
		const reservation = await reserveIdempotencyKey({
			actorId: actor.id,
			key: idempotencyKey,
			noteIri,
		});
		if (reservation.type === 'duplicate') {
			const status = await getStatusByIri(reservation.noteIri);
			if (status === undefined) {
				// 先行リクエストがまだ Note を保存していない (Mastodon のロック取得失敗と同じ扱い)。
				res.status(503).json({ error: 'Duplicate request is in progress, try again later' });
				return;
			}
			res.json(status);
			return;
		}
		({ release } = reservation);
	}

	try {
		await publishNote(actor, {
			id: noteIri,
			content: plainTextToHtml(text),
			visibility: body.visibility ?? 'public',
			inReplyTo: replyTarget?.id,
			mentions: replyTarget ? toIdArray(replyTarget.attributedTo).slice(0, 1) : [],
			summary: spoilerText === '' ? undefined : spoilerText,
			sensitive: spoilerText !== '' || (toBoolean(body.sensitive) ?? false),
			language: body.language ?? undefined,
		});
	} catch (error) {
		// Note が保存されていなければ、再送で作り直せるよう予約を取り消す。
		// 保存済みで配送だけ失敗した場合は、再送で重複しないよう予約を残す。
		if (release !== undefined && (await apex.store.getObject(noteIri)) === undefined) {
			await release();
		}
		logger.error({ type: 'postStatusError', error: toError(error).message });
		res.status(500).json({ error: 'Failed to create the status' });
		return;
	}

	const status = await getStatusByIri(noteIri);
	assert(status !== undefined, 'created status is undefined');
	res.json(status);
});

const MAX_ANCESTORS = 40;
const MAX_DESCENDANTS = 60;
const MAX_DESCENDANTS_DEPTH = 20;

export const statusParamsSchema = z.object({
	id: z.string().min(1),
});

export const getStatusAncestors = async (
	note: NoteObject,
	viewer: APActor | undefined,
	viewerFollowing: Set<string>,
): Promise<StatusEntity[]> => {
	const ancestorNotes: NoteObject[] = [];
	const visited = new Set<string>([note.id]);
	let currentReplyTo = toIdArray(note.inReplyTo)[0];

	while (currentReplyTo !== undefined && ancestorNotes.length < MAX_ANCESTORS) {
		if (visited.has(currentReplyTo)) {
			// 循環参照を検出したら停止 (→ ADR-0064)
			break;
		}
		visited.add(currentReplyTo);
		const parent = await apex.store.getObject(currentReplyTo);
		if (!isAPNote(parent)) {
			// 手元に存在しないか Note でなければチェーン終了 (リモートへは取りに行かない → ADR-0059)
			break;
		}
		ancestorNotes.push(parent);
		currentReplyTo = toIdArray(parent.inReplyTo)[0];
	}

	ancestorNotes.reverse();
	const visibleAncestors = ancestorNotes.filter((ancestor) =>
		isNoteVisibleTo(ancestor, viewer?.id, viewerFollowing),
	);
	return notesToStatuses(visibleAncestors);
};

export const getStatusDescendants = async (
	note: NoteObject,
	viewer: APActor | undefined,
	viewerFollowing: Set<string>,
): Promise<StatusEntity[]> => {
	const descendantNotes: NoteObject[] = [];
	const visited = new Set<string>([note.id]);

	const collect = async (parentIri: string, depth: number) => {
		if (depth >= MAX_DESCENDANTS_DEPTH || descendantNotes.length >= MAX_DESCENDANTS) {
			return;
		}
		const rawReplies = await apex.store.getReplies(parentIri);
		const replies = rawReplies.filter(isAPNote);

		// Mastodon 仕様: 親と同じ投稿者による返信 (self-reply) を優先して上位に持ってくる
		const parentNote = descendantNotes.find((d) => d.id === parentIri) ?? note;
		const parentAuthor = getAttributedTo(parentNote);
		const sortedReplies =
			parentAuthor === undefined
				? replies
				: [...replies].sort((a, b) => {
						const aIsSelf = getAttributedTo(a) === parentAuthor;
						const bIsSelf = getAttributedTo(b) === parentAuthor;
						if (aIsSelf && !bIsSelf) {
							return -1;
						}
						if (!aIsSelf && bIsSelf) {
							return 1;
						}
						return 0;
					});

		for (const reply of sortedReplies) {
			if (visited.has(reply.id) || descendantNotes.length >= MAX_DESCENDANTS) {
				continue;
			}
			visited.add(reply.id);
			descendantNotes.push(reply);
			await collect(reply.id, depth + 1);
		}
	};

	await collect(note.id, 0);

	const visibleDescendants = descendantNotes.filter((descendant) =>
		isNoteVisibleTo(descendant, viewer?.id, viewerFollowing),
	);
	return notesToStatuses(visibleDescendants);
};

router.get('/v1/statuses/:id/context', async (req, res) => {
	const parsedParams = statusParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const iri = await getIriByMastodonId(parsedParams.data.id);
	const note = iri === undefined ? undefined : await apex.store.getObject(iri);
	if (!isAPNote(note)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const viewer = await getOptionalViewer(req, res);
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	if (!isNoteVisibleTo(note, viewer?.id, viewerFollowing)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const [ancestors, descendants] = await Promise.all([
		getStatusAncestors(note, viewer, viewerFollowing),
		getStatusDescendants(note, viewer, viewerFollowing),
	]);

	res.json({ ancestors, descendants });
});

router.get('/v1/statuses/:id', async (req, res) => {
	const parsedParams = statusParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const iri = await getIriByMastodonId(parsedParams.data.id);
	const note = iri === undefined ? undefined : await apex.store.getObject(iri);
	if (!isAPNote(note)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const viewer = await getOptionalViewer(req, res);
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	if (!isNoteVisibleTo(note, viewer?.id, viewerFollowing)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const [status] = await notesToStatuses([note]);
	if (status === undefined) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	res.json(status);
});

router.delete(
	'/v1/statuses/:id',
	authRequired,
	scopeRequired('write:statuses'),
	async (req, res) => {
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		// 自分の投稿のみ削除可能。他人の投稿なら 404 (存在秘匿 → ADR-0064)。
		if (getAttributedTo(note) !== actor.id) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		// 削除前の Note から Status を生成する (Mastodon 仕様: 削除して再編集するために本文が必要)。
		const [status] = await notesToStatuses([note]);
		assert(status !== undefined, 'status is undefined');
		const statusWithText: StatusEntity = {
			...status,
			text: htmlToPlainText(status.content),
		};

		await deleteNote(actor, note);

		res.json(statusWithText);
	},
);

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

// fallback all /api routes to 404 (→ ADR-0067)
router.use('/', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

export default router;
