import assert from 'node:assert';
import type { CollectionReference, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { chunk, uniq } from 'lodash-es';
import type { APActor } from 'activitypub-types';
import type { APObject } from '../apex/index.js';
import { domain, escapeFirestoreKey, toFirestoreKey, unescapeFirestoreKey } from '../firebase.js';
import { getObjectHashtags } from '../hashtags.js';
import { getMastodonIds, mastodonIdToTimestamp } from '../mastodonId.js';
import type { PageParams } from '../pagination.js';
import { isAscending, isIdInRange, lowerBoundId, takePage } from '../pagination.js';
import { timelineFeedsMarkerRef } from '../projections/timelineFeeds.js';
import { HomeFeed, ListFeed, UserInfos } from '../schema.js';
import type { ListRecord, TimelineFeedEntry } from '../schema.js';
import { getAttributedTo, isAPAnnounce, isAPNote, toArray, toIdArray } from '../utils.js';
import { getFollowing } from './follows.js';
import { getExclusiveListMembers } from './lists.js';
import type { NoteObject } from './types.js';
import { isNotePublicTimelineEligible, isNoteVisibleTo, noteToVisibility } from './visibility.js';
import { getObjects } from '../store/objects.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../store/limits.js';
import { getNotes } from '../store/notes.js';
import { getActivities, getAnnounces } from '../store/activities.js';

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
	hashtags,
	page,
	isVisible,
}: {
	actors?: string[] | undefined;
	hashtags?: string[] | undefined;
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
			hashtags,
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

// ブースト先の Note が手元にあり、public / unlisted で、viewer に見えるか (→ ADR-0096 決定4)。
const isVisibleBoostTarget = (
	targetNote: NoteObject | undefined,
	viewer: APActor | undefined,
	viewerFollowing: Set<string>,
): targetNote is NoteObject => {
	if (targetNote === undefined) {
		return false;
	}
	const targetVis = noteToVisibility(targetNote);
	return (
		(targetVis === 'public' || targetVis === 'unlisted') &&
		isNoteVisibleTo(targetNote, viewer?.id, viewerFollowing)
	);
};

// Note と Announce を混ぜて 1 ページ分集める (→ ADR-0096)。
// 各情報源のカーソルを独立して進め、可視性チェックを通過した有効なアイテムを Mastodon ID 順にマージする。
// `filterNotes` は可視性チェックの後の Note (ブーストは含まない) をさらに絞る (リストの replies_policy。→ ADR-0134)。
export const collectTimelineItems = async ({
	actors,
	page,
	viewer,
	viewerFollowing,
	includeAnnounces = true,
	filterNotes,
}: {
	actors?: string[] | undefined;
	page: PageParams;
	viewer?: APActor | undefined;
	viewerFollowing: Set<string>;
	includeAnnounces?: boolean;
	filterNotes?: ((notes: NoteObject[]) => Promise<NoteObject[]>) | undefined;
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
		const visibleToViewer = rows
			.filter(isAPNote)
			.filter(
				(note) =>
					getAttributedTo(note) !== undefined && isNoteVisibleTo(note, viewer?.id, viewerFollowing),
			);
		const visible =
			filterNotes === undefined ? visibleToViewer : await filterNotes(visibleToViewer);
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
			if (isVisibleBoostTarget(targetNote, viewer, viewerFollowing)) {
				eligibleAnnounces.push({ activity, targetNote });
			}
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

export interface HashtagTimelineOptions {
	// 正規化したタグ名 (→ ADR-0103)。
	hashtag: string;
	// いずれかを持てばよい追加のタグ (Mastodon の `any[]`)。`hashtag` と合わせて FIRESTORE_IN_QUERY_LIMIT 件まで。
	any?: string[] | undefined;
	// すべて持つ必要があるタグ (`all[]`)。
	all?: string[] | undefined;
	// 1つも持ってはいけないタグ (`none[]`)。
	none?: string[] | undefined;
	local?: boolean | undefined;
	remote?: boolean | undefined;
	onlyMedia?: boolean | undefined;
}

const isLocalNote = (note: NoteObject) =>
	getAttributedTo(note)?.startsWith(`https://${domain}/`) === true;

// ハッシュタグのタイムラインの Note。public な投稿のみ (→ ADR-0103)。
// `any` は Firestore の `array-contains-any` に足し、`all` / `none`・`local` / `remote`・`onlyMedia` は取得後に絞る。
export const getHashtagTimelineNotes = async (
	options: HashtagTimelineOptions,
	page: PageParams,
): Promise<NoteObject[]> => {
	const hashtags = uniq([options.hashtag, ...(options.any ?? [])]).slice(
		0,
		FIRESTORE_IN_QUERY_LIMIT,
	);
	const all = options.all ?? [];
	const none = options.none ?? [];
	const notes = await collectVisibleNotes({
		hashtags,
		page,
		isVisible: (note) => {
			if (!isNotePublicTimelineEligible(note)) {
				return false;
			}
			const noteHashtags = new Set(note._meta?.hashtags ?? getObjectHashtags(note));
			if (!all.every((tag) => noteHashtags.has(tag)) || none.some((tag) => noteHashtags.has(tag))) {
				return false;
			}
			if (options.local === true && !isLocalNote(note)) {
				return false;
			}
			if (options.remote === true && isLocalNote(note)) {
				return false;
			}
			return options.onlyMedia !== true || toArray(note.attachment).length > 0;
		},
	});
	return notes.map((entry) => entry.note);
};

// 手元にそのタグの公開 Note が1件でもあるか (→ ADR-0103)。
export const hasPublicHashtagNotes = async (hashtag: string): Promise<boolean> =>
	(await getHashtagTimelineNotes({ hashtag }, { limit: 1 })).length > 0;

// タイムラインの射影 (→ ADR-0136) を読むとき、判定で落ちる分を見込んで limit より多めに読む。
const MIN_FEED_FETCH_SIZE = 20;

// タイムラインの射影から読めるか (→ ADR-0136 決定5)。マーカーが無ければ従来の方式で読む。
const isTimelineFeedReady = async (actorId: string) =>
	(await timelineFeedsMarkerRef(escapeFirestoreKey(actorId)).get()).exists;

// 射影のエントリの本体を引き、従来の読み出しと同じ判定を通ったものだけをタイムラインのアイテムにする (→ ADR-0136 決定3)。
const resolveFeedEntries = async ({
	entries,
	viewer,
	viewerFollowing,
	filterNotes,
}: {
	entries: TimelineFeedEntry[];
	viewer: APActor;
	viewerFollowing: Set<string>;
	filterNotes?: ((notes: NoteObject[]) => Promise<NoteObject[]>) | undefined;
}): Promise<TimelineItem[]> => {
	const announceEntries = entries.filter((entry) => entry.type === 'announce');
	const [objects, activities] = await Promise.all([
		// Status の件数に使う `_meta` 付きで読む (→ ADR-0102)。
		getObjects(
			entries
				.flatMap((entry) => (entry.type === 'note' ? [entry.iri] : []))
				.concat(
					announceEntries.flatMap((entry) => (entry.objectIri === null ? [] : [entry.objectIri])),
				),
			true,
		),
		getActivities(announceEntries.map((entry) => entry.iri)),
	]);
	const notesByIri = new Map(objects.filter(isAPNote).map((note) => [note.id, note]));
	const announcesByIri = new Map(activities.filter(isAPAnnounce).map((row) => [row.id, row]));

	const visibleNotes = entries.flatMap((entry) => {
		const note = entry.type === 'note' ? notesByIri.get(entry.iri) : undefined;
		return note !== undefined &&
			getAttributedTo(note) !== undefined &&
			isNoteVisibleTo(note, viewer.id, viewerFollowing)
			? [note]
			: [];
	});
	const keptNoteIris = new Set(
		(filterNotes === undefined ? visibleNotes : await filterNotes(visibleNotes)).map(
			(note) => note.id,
		),
	);

	return entries.flatMap((entry): TimelineItem[] => {
		if (entry.type === 'note') {
			const note = notesByIri.get(entry.iri);
			return note !== undefined && keptNoteIris.has(note.id)
				? [{ type: 'note', id: entry.id, note }]
				: [];
		}
		const activity = announcesByIri.get(entry.iri);
		if (activity === undefined || !isNoteVisibleTo(activity, viewer.id, viewerFollowing)) {
			return [];
		}
		const targetNote = notesByIri.get(toIdArray(activity.object)[0] ?? '');
		return isVisibleBoostTarget(targetNote, viewer, viewerFollowing)
			? [{ type: 'announce', id: entry.id, activity, targetNote }]
			: [];
	});
};

// タイムラインの射影を Mastodon ID 順に読み、`isAuthorIncluded` と可視性などの判定を通ったものを
// limit 件集める (→ ADR-0136)。足りなければカーソルを進めて読み足す。
const collectFeedItems = async ({
	feed,
	page,
	viewer,
	viewerFollowing,
	isAuthorIncluded,
	filterNotes,
}: {
	feed: CollectionReference<TimelineFeedEntry>;
	page: PageParams;
	viewer: APActor;
	viewerFollowing: Set<string>;
	isAuthorIncluded: (actor: string) => boolean;
	filterNotes?: ((notes: NoteObject[]) => Promise<NoteObject[]>) | undefined;
}): Promise<TimelineItem[]> => {
	const lowerId = lowerBoundId(page);
	const fetchSize = Math.max(page.limit + Math.ceil(page.limit / 2), MIN_FEED_FETCH_SIZE);
	// ドキュメント ID の降順の走査はできないので、同じ値を持つ `id` で並べる。
	let query = feed.orderBy('id', isAscending(page) ? 'asc' : 'desc');
	if (page.maxId !== undefined) {
		query = query.where('id', '<', page.maxId);
	}
	if (lowerId !== undefined) {
		query = query.where('id', '>', lowerId);
	}

	const collected: TimelineItem[] = [];
	let cursor: QueryDocumentSnapshot<TimelineFeedEntry> | undefined;
	for (
		let round = 0;
		round < MAX_TIMELINE_FETCH_ROUNDS && dedupeBoosts(collected).length < page.limit;
		round++
	) {
		const snapshot = await (cursor === undefined ? query : query.startAfter(cursor))
			.limit(fetchSize)
			.get();
		const entries = snapshot.docs
			.map((doc) => doc.data())
			.filter((entry) => isAuthorIncluded(entry.actor));
		collected.push(
			...(await resolveFeedEntries({ entries, viewer, viewerFollowing, filterNotes })),
		);
		cursor = snapshot.docs.at(-1);
		if (snapshot.docs.length < fetchSize) {
			break;
		}
	}
	return takePage(dedupeBoosts(collected), (entry) => entry.id, page);
};

// `authors` の投稿/ブーストのうち閲覧権限のあるものを、FIRESTORE_IN_QUERY_LIMIT 人ずつに分けて集めてマージする。
const collectAuthorsTimelineItems = async ({
	authors,
	page,
	viewer,
	viewerFollowing,
	filterNotes,
}: {
	authors: string[];
	page: PageParams;
	viewer: APActor;
	viewerFollowing: Set<string>;
	filterNotes?: ((notes: NoteObject[]) => Promise<NoteObject[]>) | undefined;
}): Promise<TimelineItem[]> => {
	const chunkedResults = await Promise.all(
		chunk(authors, FIRESTORE_IN_QUERY_LIMIT).map((actors) =>
			collectTimelineItems({
				actors,
				page,
				viewer,
				viewerFollowing,
				includeAnnounces: true,
				filterNotes,
			}),
		),
	);
	const deduplicated = dedupeBoosts(chunkedResults.flat());
	return takePage(deduplicated, (entry) => entry.id, page);
};

// ホームタイムラインのアイテム (Note + Announce)。自分の投稿/ブースト + フォロー中の相手の投稿/ブーストのうち、閲覧権限のあるもの。
// `exclusive` なリストのメンバーの投稿/ブーストは載せない (→ ADR-0134 決定5)。射影があればそこから読む (→ ADR-0136)。
export const getHomeTimelineItems = async (
	viewer: APActor,
	page: PageParams,
): Promise<TimelineItem[]> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');
	const viewerId = viewer.id;
	const [following, exclusiveMembers, feedReady] = await Promise.all([
		getFollowing(viewer),
		getExclusiveListMembers(viewerId),
		isTimelineFeedReady(viewerId),
	]);
	const viewerFollowing = new Set(following);
	if (feedReady) {
		return collectFeedItems({
			feed: HomeFeed(escapeFirestoreKey(viewerId)),
			page,
			viewer,
			viewerFollowing,
			isAuthorIncluded: (actor) =>
				actor === viewerId || (viewerFollowing.has(actor) && !exclusiveMembers.has(actor)),
		});
	}
	const authors = [
		viewer.id,
		...[...viewerFollowing].filter((actor) => !exclusiveMembers.has(actor)),
	];
	return collectAuthorsTimelineItems({ authors, page, viewer, viewerFollowing });
};

// リストの replies_policy で、他人への返信を絞る (Mastodon の `FeedManager#filter_from_list?`。→ ADR-0134 決定4)。
// 返信先の作者は返信先の Note から決め、手元に無ければ出さない。
const filterRepliesByListPolicy =
	(ownerId: string, list: ListRecord, viewerFollowing: Set<string>) =>
	async (notes: NoteObject[]): Promise<NoteObject[]> => {
		const parentIris = uniq(notes.flatMap((note) => toIdArray(note.inReplyTo).slice(0, 1)));
		const parents = await getObjects(parentIris);
		const parentAuthors = new Map(
			parents.flatMap((parent) => {
				const author = getAttributedTo(parent);
				return typeof parent.id === 'string' && author !== undefined ? [[parent.id, author]] : [];
			}),
		);
		const members = new Set(list.accounts);
		return notes.filter((note) => {
			const parentIri = toIdArray(note.inReplyTo)[0];
			if (parentIri === undefined) {
				return true;
			}
			const parentAuthor = parentAuthors.get(parentIri);
			if (parentAuthor === undefined) {
				return false;
			}
			if (parentAuthor === getAttributedTo(note) || parentAuthor === ownerId) {
				return true;
			}
			switch (list.repliesPolicy) {
				case 'followed':
					return viewerFollowing.has(parentAuthor);
				case 'list':
					return members.has(parentAuthor);
				default:
					return false;
			}
		});
	};

// リストのタイムラインのアイテム (Note + Announce)。メンバーのうちフォロー中 (承認済み) の相手と自分の投稿/ブーストを、
// ホームタイムラインと同じ規則で集める。射影があればそこから読む (→ ADR-0136)。
export const getListTimelineItems = async (
	viewer: APActor,
	list: ListRecord,
	page: PageParams,
): Promise<TimelineItem[]> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');
	const viewerId = viewer.id;
	const [following, feedReady] = await Promise.all([
		getFollowing(viewer),
		isTimelineFeedReady(viewerId),
	]);
	const viewerFollowing = new Set(following);
	const authors = uniq(list.accounts).filter(
		(actor) => actor === viewerId || viewerFollowing.has(actor),
	);
	if (authors.length === 0) {
		return [];
	}
	const filterNotes = filterRepliesByListPolicy(viewerId, list, viewerFollowing);
	if (feedReady) {
		const authorSet = new Set(authors);
		return collectFeedItems({
			feed: ListFeed(escapeFirestoreKey(viewerId), toFirestoreKey(list.id)),
			page,
			viewer,
			viewerFollowing,
			isAuthorIncluded: (actor) => authorSet.has(actor),
			filterNotes,
		});
	}
	return collectAuthorsTimelineItems({ authors, page, viewer, viewerFollowing, filterNotes });
};
