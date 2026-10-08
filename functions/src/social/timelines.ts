import assert from 'node:assert';
import { chunk, uniq } from 'lodash-es';
import type { APActor } from 'activitypub-types';
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey, toFirestoreKey, unescapeFirestoreKey } from '../firebase.js';
import { getMastodonIds, mastodonIdToTimestamp } from '../mastodonId.js';
import type { PageParams } from '../pagination.js';
import { isAscending, isIdInRange, lowerBoundId, takePage } from '../pagination.js';
import { UserInfos } from '../schema.js';
import { getAttributedTo, isAPAnnounce, isAPNote, toIdArray } from '../utils.js';
import { getFollowing } from './follows.js';
import type { NoteObject } from './types.js';
import { isNotePublicTimelineEligible, isNoteVisibleTo, noteToVisibility } from './visibility.js';
import { getObjects } from '../store/objects.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../store/limits.js';
import { getNotes } from '../store/notes.js';
import { getAnnounces } from '../store/activities.js';

// 可視性で落ちる分を見込んで、1回の Firestore クエリではこの倍数だけ多めに読む。
const TIMELINE_FETCH_FACTOR = 3;
// 小さい limit でも読み足しラウンドを使い切って空ページになりにくいよう、1回に読む件数の下限を設ける。
const MIN_TIMELINE_FETCH_SIZE = 100;
const MAX_TIMELINE_FETCH_ROUNDS = 10;

// ID のタイムスタンプ部は `_meta.published` (→ ADR-0062) と同じ規則で決まるので、そのまま範囲の端にできる。
const idToPublishedBound = (id: string) => new Date(mastodonIdToTimestamp(id)).toISOString();

export interface PagedNote {
	id: string;
	note: NoteObject;
}

export type TimelineItem =
	| { type: 'note'; id: string; note: NoteObject }
	| { type: 'announce'; id: string; activity: APObject; targetNote: NoteObject };

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

// 重複ブーストは常に最新のものを優先して1件のみ残す (→ ADR-0096 決定3)。
const dedupeBoosts = (items: TimelineItem[]): TimelineItem[] => {
	const sortedDesc = [...items].sort((a, b) => b.id.localeCompare(a.id));
	const seenBoostedNoteIris = new Set<string>();
	const keptAnnounceIds = new Set<string>();
	for (const item of sortedDesc) {
		if (item.type === 'announce') {
			if (!seenBoostedNoteIris.has(item.targetNote.id)) {
				seenBoostedNoteIris.add(item.targetNote.id);
				keptAnnounceIds.add(item.id);
			}
		}
	}
	return items.filter((item) => item.type === 'note' || keptAnnounceIds.has(item.id));
};

// Note と Announce を混ぜて 1 ページ分集める (→ ADR-0096)。
// 各情報源のカーソルを独立して進め、可視性チェックを通過した有効なアイテムを Mastodon ID 順にマージする。
export const collectTimelineItems = async ({
	actors,
	page,
	viewer,
	viewerFollowing,
	includeAnnounces = true,
}: {
	actors?: string[] | undefined;
	page: PageParams;
	viewer?: APActor | undefined;
	viewerFollowing: Set<string>;
	includeAnnounces?: boolean;
}): Promise<TimelineItem[]> => {
	const ascending = isAscending(page);
	const lowerId = lowerBoundId(page);
	const lower = lowerId === undefined ? undefined : idToPublishedBound(lowerId);
	const upper = page.maxId === undefined ? undefined : idToPublishedBound(page.maxId);
	const fetchSize = Math.max(page.limit * TIMELINE_FETCH_FACTOR, MIN_TIMELINE_FETCH_SIZE);

	const collected: TimelineItem[] = [];
	const seenBoostedNoteIris = new Set<string>();

	let noteCursor: string | undefined;
	let announceCursor: string | undefined;
	let notesExhausted = false;
	let announcesExhausted = !includeAnnounces;

	const noteBuffer: { id: string; note: NoteObject }[] = [];
	const uncollectedAnnounces = new Map<
		string,
		{ id: string; activity: APObject; targetNote: NoteObject }
	>();
	let announceBuffer: { id: string; activity: APObject; targetNote: NoteObject }[] = [];

	const fetchNotes = async () => {
		if (noteBuffer.length !== 0 || notesExhausted) {
			return;
		}
		const rows = await getNotes({
			actors,
			limit: fetchSize,
			order: ascending ? 'asc' : 'desc',
			lower,
			upper,
			cursor: noteCursor,
		});
		const visible = rows
			.filter(isAPNote)
			.filter(
				(note) =>
					getAttributedTo(note) !== undefined && isNoteVisibleTo(note, viewer?.id, viewerFollowing),
			);
		const ids = await getMastodonIds(
			visible.map((note) => ({ iri: note.id, published: note.published })),
		);
		for (const note of visible) {
			const id = ids.get(note.id);
			if (id !== undefined && isIdInRange(id, page)) {
				noteBuffer.push({ id, note });
			}
		}
		const lastPublished = rows.at(-1)?._meta?.published;
		if (rows.length < fetchSize || lastPublished === undefined) {
			notesExhausted = true;
		} else {
			noteCursor = lastPublished;
		}
	};

	const fetchAnnounces = async () => {
		if (!includeAnnounces || announceBuffer.length !== 0 || announcesExhausted) {
			return;
		}
		const rows = await getAnnounces({
			actors,
			limit: fetchSize,
			order: ascending ? 'asc' : 'desc',
			lower,
			upper,
			cursor: announceCursor,
		});
		const validAnnounces = rows.filter((row): row is APObject => {
			if (!isAPAnnounce(row)) {
				return false;
			}
			const actor = toIdArray(row.actor)[0];
			if (actor === undefined) {
				return false;
			}
			if (!isNoteVisibleTo(row, viewer?.id, viewerFollowing)) {
				return false;
			}
			const targetIri = toIdArray(row.object)[0];
			return targetIri !== undefined;
		});

		const targetIris = uniq(
			validAnnounces
				.map((a) => toIdArray(a.object)[0])
				.filter((iri): iri is string => iri !== undefined),
		);
		// Status の件数に使う `_meta` 付きで読む (→ ADR-0102)。
		const targetObjects = await getObjects(targetIris, true);
		const targetNotesMap = new Map(targetObjects.filter(isAPNote).map((note) => [note.id, note]));

		const eligibleAnnounces: { activity: APObject; targetNote: NoteObject }[] = [];
		for (const activity of validAnnounces) {
			const targetIri = toIdArray(activity.object)[0] as string;
			const targetNote = targetNotesMap.get(targetIri);
			if (targetNote === undefined) {
				continue;
			}
			const targetVis = noteToVisibility(targetNote);
			if (targetVis !== 'public' && targetVis !== 'unlisted') {
				continue;
			}
			if (!isNoteVisibleTo(targetNote, viewer?.id, viewerFollowing)) {
				continue;
			}
			eligibleAnnounces.push({ activity, targetNote });
		}

		const ids = await getMastodonIds(
			eligibleAnnounces.map(({ activity }) => ({
				iri: activity.id,
				published: activity.published,
			})),
		);
		for (const { activity, targetNote } of eligibleAnnounces) {
			const id = ids.get(activity.id);
			if (id !== undefined && isIdInRange(id, page)) {
				if (!ascending && seenBoostedNoteIris.has(targetNote.id)) {
					continue;
				}
				const existing = uncollectedAnnounces.get(targetNote.id);
				if (existing === undefined || id.localeCompare(existing.id) > 0) {
					uncollectedAnnounces.set(targetNote.id, { id, activity, targetNote });
				}
			}
		}
		announceBuffer = [...uncollectedAnnounces.values()].sort((a, b) =>
			ascending ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id),
		);

		const lastPublished = rows.at(-1)?._meta?.published;
		if (rows.length < fetchSize || lastPublished === undefined) {
			announcesExhausted = true;
		} else {
			announceCursor = lastPublished;
		}
	};

	for (let round = 0; round < MAX_TIMELINE_FETCH_ROUNDS && collected.length < page.limit; round++) {
		await Promise.all([fetchNotes(), fetchAnnounces()]);

		// バッファからアイテムを取り出してマージ
		while (collected.length < page.limit && (noteBuffer.length > 0 || announceBuffer.length > 0)) {
			if (noteBuffer.length === 0 && !notesExhausted) {
				break;
			}
			if (includeAnnounces && announceBuffer.length === 0 && !announcesExhausted) {
				break;
			}

			const nextNote = noteBuffer[0];
			const nextAnnounce = announceBuffer[0];

			let takeFrom: 'note' | 'announce';
			if (nextNote === undefined) {
				takeFrom = 'announce';
			} else if (nextAnnounce === undefined) {
				takeFrom = 'note';
			} else {
				const isNoteFirst = ascending
					? nextNote.id <= nextAnnounce.id
					: nextNote.id >= nextAnnounce.id;
				takeFrom = isNoteFirst ? 'note' : 'announce';
			}

			if (takeFrom === 'note') {
				const item = noteBuffer.shift()!;
				collected.push({ type: 'note', id: item.id, note: item.note });
			} else {
				const item = announceBuffer.shift()!;
				uncollectedAnnounces.delete(item.targetNote.id);
				seenBoostedNoteIris.add(item.targetNote.id);
				collected.push({
					type: 'announce',
					id: item.id,
					activity: item.activity,
					targetNote: item.targetNote,
				});
			}
		}

		if (
			noteBuffer.length === 0 &&
			notesExhausted &&
			(!includeAnnounces || (announceBuffer.length === 0 && announcesExhausted))
		) {
			break;
		}
	}

	return takePage(dedupeBoosts(collected), (entry) => entry.id, page);
};

// actor のタイムラインアイテム (Note + Announce)。viewer に見えるものだけを返す。
// oxlint-disable-next-line max-params
export const getAccountTimelineItems = async (
	actorId: string,
	viewer: APActor | undefined,
	page: PageParams,
	options: { pinned?: boolean; excludeReblogs?: boolean } = {},
): Promise<TimelineItem[]> => {
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	if (options.pinned) {
		const actorKey = escapeFirestoreKey(actorId);
		const pinsSnap = await UserInfos.doc(actorKey).collection('pins').get();
		if (pinsSnap.empty) {
			return [];
		}
		const noteIris = pinsSnap.docs.map((doc) => unescapeFirestoreKey(toFirestoreKey(doc.id)));
		const notes = (await getObjects(noteIris, true)).filter(isAPNote);
		const visibleNotes = notes.filter((note) => isNoteVisibleTo(note, viewer?.id, viewerFollowing));
		const ids = await getMastodonIds(
			visibleNotes.map((note) => ({ iri: note.id, published: note.published })),
		);
		const items: TimelineItem[] = [];
		for (const note of visibleNotes) {
			const id = ids.get(note.id);
			if (id !== undefined) {
				items.push({ type: 'note', id, note });
			}
		}
		return items;
	}
	return collectTimelineItems({
		actors: [actorId],
		page,
		viewer,
		viewerFollowing,
		includeAnnounces: !options.excludeReblogs,
	});
};

// 公開タイムラインの Note。public な投稿のみ (unlisted / private / direct は載せない)。
export const getPublicTimelineNotes = async (page: PageParams): Promise<NoteObject[]> => {
	const notes = await collectVisibleNotes({ page, isVisible: isNotePublicTimelineEligible });
	return notes.map((entry) => entry.note);
};

// ホームタイムラインのアイテム (Note + Announce)。自分の投稿/ブースト + フォロー中の相手の投稿/ブーストのうち、閲覧権限のあるもの。
export const getHomeTimelineItems = async (
	viewer: APActor,
	page: PageParams,
): Promise<TimelineItem[]> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');
	const viewerFollowing = new Set(await getFollowing(viewer));
	const authors = [viewer.id, ...viewerFollowing];
	const chunkedResults = await Promise.all(
		chunk(authors, FIRESTORE_IN_QUERY_LIMIT).map((actors) =>
			collectTimelineItems({
				actors,
				page,
				viewer,
				viewerFollowing,
				includeAnnounces: true,
			}),
		),
	);
	const deduplicated = dedupeBoosts(chunkedResults.flat());
	return takePage(deduplicated, (entry) => entry.id, page);
};
