import assert from 'node:assert';
import type { APNote, APActor } from 'activitypub-types';
import firebase from 'firebase-admin';
import { chunk, uniq, zip } from 'lodash-es';
import type { mastodon } from 'masto';
import { apex } from '../../apex.js';
import { getReactedNoteIris } from '../../social/reactions.js';
import { getThreadAncestors, getThreadDescendants } from '../../social/threads.js';
import {
	getAccountNotes,
	getHomeTimelineNotes,
	getPublicTimelineNotes,
} from '../../social/timelines.js';
import type { NoteObject } from '../../social/types.js';
import {
	domain,
	escapeFirestoreKey,
	toFirestoreKey,
	unescapeFirestoreKey,
} from '../../firebase.js';
import { getMastodonIds } from '../../mastodonId.js';
import { UserInfos } from '../../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../../store.js';
import type { CamelToSnake } from '../../utils.js';
import { getAttributedTo, isAPNote, toIdArray, toStringValue } from '../../utils.js';
import type { PageParams } from '../pagination.js';
import {
	getMentionIris,
	noteToCounts,
	noteToEditedAt,
	noteToEmojis,
	noteToHashtags,
	noteToLanguage,
	noteToMentions,
	noteToViewerAttributes,
	noteToVisibility,
} from '../statusAttributes.js';
import type { StatusViewerContext } from '../statusAttributes.js';
import { resolveAccountIds, userIdsToAccounts } from './account.js';

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
	// メンション先の actor IRI とそのアカウント ID のマップ (→ ADR-0069)。
	mentionIds?: Map<string, string> | Record<string, string> | undefined;
	// 認証ユーザー (viewer) のインタラクション状態 (→ ADR-0070)。
	viewer?: StatusViewerContext | undefined;
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
		...noteToViewerAttributes(note, context.viewer),
		muted: false,
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
		mentions: noteToMentions(note, context.mentionIds),
		tags: noteToHashtags(note),
		emojis: noteToEmojis(note),
		card: null,
		poll: null,
	};
};

// Note を Status エンティティへ変換する。可視性の絞り込みは呼び出し側で済ませておくこと。

export interface ViewerRelationships {
	favourited: Set<string>;
	reblogged: Set<string>;
	bookmarked: Set<string>;
	pinned: Set<string>;
}

// 認証ユーザー (viewer) と対象 Note 群との関係 (favourite / reblog / bookmark / pin) を一括解決する (→ ADR-0070, ADR-0084)。
export const getViewerRelationships = async (
	viewer: APActor | undefined,
	notes: NoteObject[],
): Promise<ViewerRelationships> => {
	const empty: ViewerRelationships = {
		favourited: new Set(),
		reblogged: new Set(),
		bookmarked: new Set(),
		pinned: new Set(),
	};
	if (viewer === undefined || viewer.id === undefined || notes.length === 0) {
		return empty;
	}

	const actorKey = escapeFirestoreKey(viewer.id);
	const noteIris = notes.map((note) => note.id).filter((id): id is string => id !== undefined);
	const ownNoteIris = notes
		.filter((note) => getAttributedTo(note) === viewer.id)
		.map((note) => note.id)
		.filter((id): id is string => id !== undefined);

	// 1. Favourites / reblogs from the projection (→ ADR-0084)
	const [favourited, reblogged] = await Promise.all([
		getReactedNoteIris(viewer.id, 'favourites', noteIris),
		getReactedNoteIris(viewer.id, 'reblogs', noteIris),
	]);

	// 2. Bookmarks from userInfos/{actorKey}/bookmarks
	const bookmarked = new Set<string>();
	const bookmarksCollection = UserInfos.doc(actorKey).collection('bookmarks');
	const noteIdChunks = chunk(noteIris.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT);
	const bookmarkSnaps = await Promise.all(
		noteIdChunks.map((idChunk) =>
			bookmarksCollection.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
		),
	);
	for (const snap of bookmarkSnaps) {
		for (const doc of snap.docs) {
			const iri = unescapeFirestoreKey(toFirestoreKey(doc.id));
			bookmarked.add(iri);
		}
	}

	// 3. Pins from userInfos/{actorKey}/pins
	const pinned = new Set<string>();
	if (ownNoteIris.length > 0) {
		const pinsCollection = UserInfos.doc(actorKey).collection('pins');
		const ownIdChunks = chunk(ownNoteIris.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT);
		const pinSnaps = await Promise.all(
			ownIdChunks.map((idChunk) =>
				pinsCollection.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
			),
		);
		for (const snap of pinSnaps) {
			for (const doc of snap.docs) {
				const iri = unescapeFirestoreKey(toFirestoreKey(doc.id));
				pinned.add(iri);
			}
		}
	}

	return { favourited, reblogged, bookmarked, pinned };
};

export const notesToStatuses = async (notes: NoteObject[], viewer?: APActor | undefined) => {
	const validNotes = notes.filter((note) => getAttributedTo(note) !== undefined);

	// リプライ先は手元に保存済みのものだけ解決する (リモートへは取りに行かない → ADR-0059)。
	const replyTargetIris = uniq(validNotes.flatMap((note) => toIdArray(note.inReplyTo).slice(0, 1)));
	const replyTargets = (await apex.store.getObjects(replyTargetIris)).filter(isAPNote);
	const replyTargetMap = new Map(replyTargets.map((target) => [target.id, target]));

	const authorIris = uniq([
		...validNotes.map((note) => getAttributedTo(note)),
		...replyTargets.map((target) => getAttributedTo(target)),
	]).filter((iri): iri is string => iri !== undefined);

	const mentionIris = uniq(validNotes.flatMap((note) => getMentionIris(note)));
	const allAccountIris = uniq([...authorIris, ...mentionIris]);

	const [accountIds, mastodonIds, viewerRelations] = await Promise.all([
		resolveAccountIds(allAccountIris),
		getMastodonIds(
			[...validNotes, ...replyTargets].map((note) => ({ iri: note.id, published: note.published })),
		),
		getViewerRelationships(viewer, validNotes),
	]);
	const accounts = await userIdsToAccounts(authorIris, accountIds);
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

		return noteObjectToStatus(note, account, mastodonId, {
			inReplyTo,
			meta: note._meta,
			mentionIds: accountIds,
			viewer: viewerRelations,
		});
	});
};

export const STATUS_PAGE_LIMITS = { defaultLimit: 20, maxLimit: 40 };

// actor の投稿一覧。viewer に見えるものだけを返す。
// oxlint-disable-next-line max-params
export const getAccountStatuses = async (
	actorId: string,
	viewer: APActor | undefined,
	page: PageParams,
	options: { pinned?: boolean } = {},
) => notesToStatuses(await getAccountNotes(actorId, viewer, page, options), viewer);

// 公開タイムライン。public な投稿のみ (unlisted / private / direct は載せない)。
export const getPublicTimeline = async (page: PageParams, viewer?: APActor | undefined) =>
	notesToStatuses(await getPublicTimelineNotes(page), viewer);

// ホームタイムライン。自分の投稿 + フォロー中の相手の投稿のうち、閲覧権限のあるもの。
export const getHomeTimeline = async (viewer: APActor, page: PageParams) =>
	notesToStatuses(await getHomeTimelineNotes(viewer, page), viewer);

// 作成・重複時の応答に使う。Note でなければ (まだ保存されていなければ) undefined。
export const getStatusByIri = async (iri: string, viewer?: APActor | undefined) => {
	const note = await apex.store.getObject(iri);
	if (!isAPNote(note)) {
		return undefined;
	}
	return (await notesToStatuses([note], viewer))[0];
};

export const getStatusAncestors = async (
	note: NoteObject,
	viewer: APActor | undefined,
	viewerFollowing: Set<string>,
): Promise<StatusEntity[]> => {
	const ancestors = await getThreadAncestors(note, viewer, viewerFollowing);
	return notesToStatuses(ancestors, viewer);
};

export const getStatusDescendants = async (
	note: NoteObject,
	viewer: APActor | undefined,
	viewerFollowing: Set<string>,
): Promise<StatusEntity[]> => {
	const descendants = await getThreadDescendants(note, viewer, viewerFollowing);
	return notesToStatuses(descendants, viewer);
};
