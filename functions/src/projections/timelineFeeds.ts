import type { CollectionReference, Transaction, WriteBatch } from '@google-cloud/firestore';
import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { chunk, isEqual } from 'lodash-es';
import type { APObject } from '../apex/index.js';
import { db, escapeFirestoreKey, toFirestoreKey } from '../firebase.js';
import type { FirestoreKey } from '../firebase.js';
import { localActorId } from '../localActor.js';
import { findMastodonIds, getMastodonIds, mastodonIdToTimestamp } from '../mastodonId.js';
import { FollowRelations, HomeFeed, ListFeed, Lists, ProjectionVersions } from '../schema.js';
import type { TimelineFeedEntry, TimelineFeedEntryType } from '../schema.js';
import { getAnnounces } from '../store/activities.js';
import { getNotes } from '../store/notes.js';
import { getAttributedTo, isAPAnnounce, isAPNote, toIdArray } from '../utils.js';

// ホーム・リストのタイムラインの射影 (`userInfos/{ローカル actor}/homeFeed/{Mastodon ID}` と
// `.../lists/{リスト ID}/feed/{Mastodon ID}`) を、Note / Announce の新規保存時に書く (→ ADR-0136)。
// 射影は読み出し時に可視性などを判定し直す候補なので、フォロー解除や削除では消さない。
// `social/` や `mastodon/` を import しないこと。

// フォロー・リストへの追加時に射影へ入れる、相手の最新の Note / Announce の件数 (それぞれ)。
// Mastodon の `FeedManager::MAX_ITEMS / 4` と同じ。
export const MERGE_LIMIT = 200;
const AUTHOR_SCAN_PAGE_SIZE = 500;
const BATCH_SIZE = 500;

export interface TimelineFeedCandidate {
	type: TimelineFeedEntryType;
	iri: string;
	actor: string;
	objectIri: string | null;
	published: unknown;
}

export interface TimelineFeedTargets {
	home: boolean;
	listIds: string[];
}

// Note / Announce が射影の候補になるなら、その内容を返す。タイムラインの並べ替えキー
// (`_meta.published`。→ ADR-0062) が無いものは従来の読み出しでも載らないので候補にしない。
export const timelineFeedCandidateOf = (
	object: APObject | undefined,
): TimelineFeedCandidate | undefined => {
	if (object?.id === undefined || object._meta?.published === undefined) {
		return undefined;
	}
	if (isAPNote(object)) {
		const actor = getAttributedTo(object);
		return actor === undefined
			? undefined
			: { type: 'note', iri: object.id, actor, objectIri: null, published: object.published };
	}
	if (isAPAnnounce(object)) {
		const actor = toIdArray(object.actor)[0];
		const objectIri = toIdArray(object.object)[0];
		return actor === undefined || objectIri === undefined
			? undefined
			: { type: 'announce', iri: object.id, actor, objectIri, published: object.published };
	}
	return undefined;
};

const userInfoKey = () => escapeFirestoreKey(localActorId);

// タイムラインの射影が使えることを示すマーカー。ある間だけ射影から読む (→ ADR-0136 決定5)。
export const timelineFeedsMarkerRef = (key: FirestoreKey) =>
	ProjectionVersions(key).doc(toFirestoreKey('timelineFeeds'));

export const buildTimelineFeedEntry = (
	candidate: TimelineFeedCandidate,
	id: string,
): TimelineFeedEntry => ({
	id,
	type: candidate.type,
	iri: candidate.iri,
	actor: candidate.actor,
	objectIri: candidate.objectIri,
	// バックフィルで比較できるよう、書くたびに同じ値になる ID の時刻を使う。
	createdAt: firebase.firestore.Timestamp.fromMillis(
		mastodonIdToTimestamp(id),
	) as unknown as TimelineFeedEntry['createdAt'],
});

const feedsOf = (targets: TimelineFeedTargets): CollectionReference<TimelineFeedEntry>[] => {
	const key = userInfoKey();
	return [
		...(targets.home ? [HomeFeed(key)] : []),
		...targets.listIds.map((listId) => ListFeed(key, toFirestoreKey(listId))),
	];
};

// 作者の投稿をどの射影に書くかを決める。ホームは作者がローカル actor か following の射影 (承認待ちを含む) に
// あるとき、リストはさらに作者をメンバーに含むもの。ホームに載らない作者はリストにも書かない
// (リストの読み出しはフォロー中の相手しか出さない。→ ADR-0134 決定2)。
export const resolveTimelineFeedTargets = async (author: string): Promise<TimelineFeedTargets> => {
	const key = userInfoKey();
	const home =
		author === localActorId ||
		(await FollowRelations(key, 'following').doc(escapeFirestoreKey(author)).get()).exists;
	if (!home) {
		return { home: false, listIds: [] };
	}
	const lists = await Lists(key).where('accounts', 'array-contains', author).get();
	return { home, listIds: lists.docs.map((doc) => doc.id) };
};

// トランザクション内で射影の更新を準備する (→ ADR-0082 と同じ形)。新規に保存した Note / Announce だけを扱う。
// 書き込み先はトランザクションの外で読む。射影は読み出し時に判定し直す候補なので一貫性は要らず、
// following やリストのドキュメントをロックして受信のトランザクションを競合させないため。
// 受信を落とさないよう、準備で例外が起きたらログに残して射影を諦める (→ ADR-0136 決定2)。
export const prepareTimelineFeedUpdate = async (
	transaction: Transaction,
	before: APObject | undefined,
	after: APObject | undefined,
): Promise<((mastodonId?: string) => void) | undefined> => {
	if (before !== undefined) {
		return undefined;
	}
	const candidate = timelineFeedCandidateOf(after);
	if (candidate === undefined) {
		return undefined;
	}
	let targets: TimelineFeedTargets;
	try {
		targets = await resolveTimelineFeedTargets(candidate.actor);
	} catch (error) {
		logger.error({ type: 'prepareTimelineFeedUpdate', iri: candidate.iri, error });
		return undefined;
	}
	const feeds = feedsOf(targets);
	if (feeds.length === 0) {
		return undefined;
	}
	return (mastodonId) => {
		if (mastodonId === undefined) {
			logger.error({ type: 'prepareTimelineFeedUpdate', iri: candidate.iri, error: 'no id' });
			return;
		}
		const entry = buildTimelineFeedEntry(candidate, mastodonId);
		for (const feed of feeds) {
			transaction.set(feed.doc(toFirestoreKey(mastodonId)), entry);
		}
	};
};

// 作者の Note / Announce を新しい順に読み、射影の候補にする。`limit` を省くと全件。
const loadAuthorCandidates = async (
	author: string,
	limit?: number,
): Promise<TimelineFeedCandidate[]> => {
	const scan = async (fetch: typeof getNotes) => {
		const rows: APObject[] = [];
		const max = limit ?? Infinity;
		let cursor: string | undefined;
		while (rows.length < max) {
			const pageSize = Math.min(AUTHOR_SCAN_PAGE_SIZE, max - rows.length);
			const page = await fetch({ actors: [author], limit: pageSize, cursor });
			rows.push(...page);
			const last = page.at(-1)?._meta?.published;
			if (page.length < pageSize || last === undefined) {
				break;
			}
			cursor = last;
		}
		return rows;
	};
	const [notes, announces] = await Promise.all([scan(getNotes), scan(getAnnounces)]);
	return [...notes, ...announces].flatMap((row) => {
		const candidate = timelineFeedCandidateOf(row);
		return candidate === undefined || candidate.actor !== author ? [] : [candidate];
	});
};

const toEntries = async (candidates: TimelineFeedCandidate[], assign = true) => {
	const ids = new Map<string, string>();
	for (const group of chunk(candidates, BATCH_SIZE)) {
		const found = assign
			? await getMastodonIds(group.map((c) => ({ iri: c.iri, published: c.published })))
			: await findMastodonIds(group.map((c) => c.iri));
		for (const [iri, id] of found) {
			ids.set(iri, id);
		}
	}
	return candidates.flatMap((candidate) => {
		const id = ids.get(candidate.iri);
		return id === undefined ? [] : [buildTimelineFeedEntry(candidate, id)];
	});
};

const commitInBatches = async (operations: ((batch: WriteBatch) => void)[]) => {
	for (const group of chunk(operations, BATCH_SIZE)) {
		const batch = db.batch();
		for (const operation of group) {
			operation(batch);
		}
		await batch.commit();
	}
};

// 相手の最新の Note / Announce を射影へ入れる (Mastodon の `merge_into_home` / `merge_into_list`。→ ADR-0136 決定4)。
// `targets` を省くと、`prepareTimelineFeedUpdate` と同じ規則で決める。
export const mergeIntoTimelineFeeds = async (author: string, targets?: TimelineFeedTargets) => {
	const feeds = feedsOf(targets ?? (await resolveTimelineFeedTargets(author)));
	if (feeds.length === 0) {
		return 0;
	}
	const entries = await toEntries(await loadAuthorCandidates(author, MERGE_LIMIT));
	await commitInBatches(
		feeds.flatMap((feed) =>
			entries.map((entry) => (batch) => batch.set(feed.doc(toFirestoreKey(entry.id)), entry)),
		),
	);
	return entries.length;
};

// 射影をすべての Note / Announce から作り直し、最後にマーカーを書く (→ ADR-0136 決定5)。バックフィル用。
// 作者はローカル actor と following の射影 (承認待ちを含む) の相手。dry-run では採番せず、書き込みもしない。
export const rebuildTimelineFeeds = async ({ dryRun = false } = {}) => {
	const key = userInfoKey();
	const [followingDocs, listDocs] = await Promise.all([
		FollowRelations(key, 'following').get(),
		Lists(key).get(),
	]);
	const authors = [localActorId, ...followingDocs.docs.map((doc) => doc.data().actor)];
	const entriesByAuthor = new Map<string, TimelineFeedEntry[]>();
	for (const author of authors) {
		entriesByAuthor.set(author, await toEntries(await loadAuthorCandidates(author), !dryRun));
	}

	const feeds: { feed: CollectionReference<TimelineFeedEntry>; members: string[] }[] = [
		{ feed: HomeFeed(key), members: authors },
		...listDocs.docs.map((doc) => ({
			feed: ListFeed(key, toFirestoreKey(doc.id)),
			members: doc.data().accounts.filter((actor) => entriesByAuthor.has(actor)),
		})),
	];

	const stats = { feeds: feeds.length, entries: 0, written: 0, deleted: 0 };
	const operations: ((batch: WriteBatch) => void)[] = [];
	for (const { feed, members } of feeds) {
		const existing = new Map((await feed.get()).docs.map((doc) => [doc.id, doc.data()]));
		for (const member of members) {
			for (const entry of entriesByAuthor.get(member) ?? []) {
				stats.entries++;
				const current = existing.get(entry.id);
				existing.delete(entry.id);
				if (current !== undefined && isEqual(current, entry)) {
					continue;
				}
				stats.written++;
				operations.push((batch) => batch.set(feed.doc(toFirestoreKey(entry.id)), entry));
			}
		}
		for (const id of existing.keys()) {
			stats.deleted++;
			operations.push((batch) => batch.delete(feed.doc(id)));
		}
	}

	if (!dryRun) {
		await commitInBatches(operations);
		await timelineFeedsMarkerRef(key).set({
			updatedAt:
				firebase.firestore.FieldValue.serverTimestamp() as unknown as TimelineFeedEntry['createdAt'],
		});
	}
	return stats;
};
