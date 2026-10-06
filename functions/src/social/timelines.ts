import assert from 'node:assert';
import { chunk } from 'lodash-es';
import type { APActor } from 'activitypub-types';
import { escapeFirestoreKey, toFirestoreKey, unescapeFirestoreKey } from '../firebase.js';
import { getMastodonIds, mastodonIdToTimestamp } from '../mastodonId.js';
import type { PageParams } from '../pagination.js';
import { isAscending, isIdInRange, lowerBoundId, takePage } from '../pagination.js';
import { UserInfos } from '../schema.js';
import { getAttributedTo, isAPNote } from '../utils.js';
import { getFollowing } from './follows.js';
import type { NoteObject } from './types.js';
import { isNotePublicTimelineEligible, isNoteVisibleTo } from './visibility.js';
import { getObjects } from '../store/objects.js';
import { getNotes } from '../store/notes.js';

// 可視性で落ちる分を見込んで、1回の Firestore クエリではこの倍数だけ多めに読む。
const TIMELINE_FETCH_FACTOR = 3;
// 小さい limit でも読み足しラウンドを使い切って空ページになりにくいよう、1回に読む件数の下限を設ける。
const MIN_TIMELINE_FETCH_SIZE = 100;
const MAX_TIMELINE_FETCH_ROUNDS = 10;
const NOTE_AUTHORS_QUERY_LIMIT = 30;

// ID のタイムスタンプ部は `_meta.published` (→ ADR-0062) と同じ規則で決まるので、そのまま範囲の端にできる。
const idToPublishedBound = (id: string) => new Date(mastodonIdToTimestamp(id)).toISOString();

export interface PagedNote {
	id: string;
	note: NoteObject;
}

// `page` のカーソルに沿って Note を読み、`isVisible` を通ったものを limit 件集めて新しい順に返す。
// 可視性の判定は Firestore のクエリでは表現できないため、足りなければカーソルを進めて読み足す。
export const collectVisibleNotes = async ({
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
		const rows = await getNotes({
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

// actor の投稿一覧 (Note)。viewer に見えるものだけを返す。
// oxlint-disable-next-line max-params
export const getAccountNotes = async (
	actorId: string,
	viewer: APActor | undefined,
	page: PageParams,
	options: { pinned?: boolean } = {},
): Promise<NoteObject[]> => {
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	if (options.pinned) {
		const actorKey = escapeFirestoreKey(actorId);
		const pinsSnap = await UserInfos.doc(actorKey).collection('pins').get();
		if (pinsSnap.empty) {
			return [];
		}
		const noteIris = pinsSnap.docs.map((doc) => unescapeFirestoreKey(toFirestoreKey(doc.id)));
		const notes = (await getObjects(noteIris)).filter(isAPNote);
		return notes.filter((note) => isNoteVisibleTo(note, viewer?.id, viewerFollowing));
	}
	const notes = await collectVisibleNotes({
		actors: [actorId],
		page,
		isVisible: (note) => isNoteVisibleTo(note, viewer?.id, viewerFollowing),
	});
	return notes.map((entry) => entry.note);
};

// 公開タイムラインの Note。public な投稿のみ (unlisted / private / direct は載せない)。
export const getPublicTimelineNotes = async (page: PageParams): Promise<NoteObject[]> => {
	const notes = await collectVisibleNotes({ page, isVisible: isNotePublicTimelineEligible });
	return notes.map((entry) => entry.note);
};

// ホームタイムラインの Note。自分の投稿 + フォロー中の相手の投稿のうち、閲覧権限のあるもの。
export const getHomeTimelineNotes = async (
	viewer: APActor,
	page: PageParams,
): Promise<NoteObject[]> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');
	const viewerFollowing = new Set(await getFollowing(viewer));
	const authors = [viewer.id, ...viewerFollowing];
	const entries = (
		await Promise.all(
			chunk(authors, NOTE_AUTHORS_QUERY_LIMIT).map((actors) =>
				collectVisibleNotes({
					actors,
					page,
					isVisible: (note) => isNoteVisibleTo(note, viewer.id, viewerFollowing),
				}),
			),
		)
	).flat();
	return takePage(entries, (entry) => entry.id, page).map((entry) => entry.note);
};
