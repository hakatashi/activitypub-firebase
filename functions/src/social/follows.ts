import assert from 'node:assert';
import type { APActor } from 'activitypub-types';
import { apex } from '../apex.js';
import { escapeFirestoreKey } from '../firebase.js';
import { getMastodonIds } from '../mastodonId.js';
import { metaIndexPath } from '../meta.js';
import type { PageParams } from '../pagination.js';
import { isIdInRange, takePage } from '../pagination.js';
import { Streams } from '../schema.js';
import { isAPFollow, isAPUndo, toIdArray } from '../utils.js';

// 同じ actor から同じ相手への Follow が複数残ると、followers コレクションに同じ actor が
// 重複して並ぶ (→ ADR-0075)。新しい Follow を受理するとき、置き換えられる古い Follow を消す。
// Mastodon の Undo は最新の Follow の IRI を指すため、古い Follow が残ると Undo しても
// フォロワーのまま残ってしまう問題も防げる。
export const removeSupersededFollows = async (
	actorId: string,
	objectId: string,
	keepFollowId: string,
): Promise<number> => {
	const docs = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('actors', escapeFirestoreKey(actorId)), '==', true)
		.where(metaIndexPath('objects', escapeFirestoreKey(objectId)), '==', true)
		.get();
	const stale = docs.docs.filter((doc) => doc.data().id !== keepFollowId);
	// Store 経由で消し、フォロー関係の射影も同じトランザクションで更新する (→ ADR-0082)。
	await Promise.all(stale.map((doc) => apex.store.removeActivity(doc.data(), actorId)));
	return stale.length;
};

const getInboxId = (actor: APActor): string => {
	const inboxId = toIdArray(actor.inbox)[0];
	if (inboxId !== undefined) {
		return inboxId;
	}
	throw new Error('inbox is not string');
};

export interface OutgoingFollows {
	following: Map<string, { followIri: string; published: unknown }>;
	pending: Set<string>;
}

export interface FollowPageEntry {
	actorIri: string;
	cursorId: string;
}

// actor 発のフォロー状態 (Accept 済みで Undo されていないもの、および未 Accept で Undo されていない保留中のもの) を
// 同一クエリ群から一括して解決する (→ ADR-0080)。
export const resolveOutgoingFollows = async (actor: APActor): Promise<OutgoingFollows> => {
	assert(actor.id !== undefined, 'actor.id is undefined');
	const actorKey = escapeFirestoreKey(actor.id);

	const followStreams = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('actors', actorKey), '==', true)
		.get();
	if (followStreams.empty) {
		return { following: new Map(), pending: new Set() };
	}

	const [acceptStreams, undoStreams] = await Promise.all([
		Streams.where(metaIndexPath('collections', escapeFirestoreKey(getInboxId(actor))), '==', true)
			.where('type', '==', 'Accept')
			.get(),
		Streams.where('type', '==', 'Undo').where(metaIndexPath('actors', actorKey), '==', true).get(),
	]);

	const acceptedFollowIds = new Set(
		acceptStreams.docs.flatMap((doc) => toIdArray(doc.data().object)),
	);
	const undoneFollowIds = new Set(undoStreams.docs.flatMap((doc) => toIdArray(doc.data().object)));

	const following = new Map<string, { followIri: string; published: unknown }>();
	const pending = new Set<string>();

	for (const followStream of followStreams.docs) {
		const follow = followStream.data();
		if (!isAPFollow(follow)) {
			continue;
		}
		if (undoneFollowIds.has(follow.id)) {
			continue;
		}
		const target = toIdArray(follow.object)[0];
		if (target === undefined) {
			continue;
		}
		if (acceptedFollowIds.has(follow.id)) {
			if (!following.has(target)) {
				following.set(target, { followIri: follow.id, published: follow.published });
			}
		} else {
			pending.add(target);
		}
	}

	return { following, pending };
};

// フォロー中 (相手が Accept 済みで Undo されていない) の相手ごとに、最初の Follow を返す。
// 同じ相手への Follow が複数残っていても 1 人として数える (→ ADR-0075)。
export const collectFollowing = async (
	actor: APActor,
): Promise<Map<string, { followIri: string; published: unknown }>> =>
	(await resolveOutgoingFollows(actor)).following;

// viewer がフォロー中 (相手が Accept 済みで Undo されていない) の actor IRI の配列を返す。
export const getFollowing = async (actor: APActor): Promise<string[]> =>
	Array.from((await collectFollowing(actor)).keys());

// 送信した Follow のうち、相手が未 Accept で Undo されていない対象 actor IRI の集合を返す。
export const getPendingFollowTargetIris = async (actor: APActor): Promise<Set<string>> =>
	(await resolveOutgoingFollows(actor)).pending;

// フォロワー (自分宛の Follow で Undo されていない) の相手ごとに、最初の Follow を返す。
export const collectFollowers = async (
	actor: APActor,
): Promise<Map<string, { followIri: string; published: unknown }>> => {
	assert(actor.id !== undefined, 'actor.id is undefined');

	const [followStreams, unfollowStreams] = await Promise.all([
		Streams.where('type', '==', 'Follow')
			.where(metaIndexPath('objects', escapeFirestoreKey(actor.id)), '==', true)
			.get(),
		Streams.where(metaIndexPath('collections', escapeFirestoreKey(getInboxId(actor))), '==', true)
			.where('type', '==', 'Undo')
			.get(),
	]);

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

	return followers;
};

// フォロワー (自分宛の Follow で Undo されていない) の actor IRI の配列を返す。
export const getFollowerActorIris = async (actor: APActor): Promise<string[]> =>
	Array.from((await collectFollowers(actor)).keys());

// カーソルは Follow アクティビティの Mastodon ID (Mastodon の follow 行 ID に相当。→ ADR-0062)。
export const getFollowersPageEntries = async (
	actor: APActor,
	page: PageParams = { limit: 40 },
): Promise<FollowPageEntry[]> => {
	const followers = await collectFollowers(actor);
	const followIds = await getMastodonIds(
		Array.from(followers.values(), ({ followIri, published }) => ({ iri: followIri, published })),
	);
	const entries = Array.from(followers, ([actorIri, { followIri }]) => ({
		actorIri,
		cursorId: followIds.get(followIri),
	})).filter(
		(entry): entry is FollowPageEntry =>
			entry.cursorId !== undefined && isIdInRange(entry.cursorId, page),
	);
	return takePage(entries, (entry) => entry.cursorId, page);
};

// カーソルは Follow アクティビティの Mastodon ID (→ ADR-0062)。
export const getFollowingPageEntries = async (
	actor: APActor,
	page: PageParams = { limit: 40 },
): Promise<FollowPageEntry[]> => {
	const following = await collectFollowing(actor);
	const followIds = await getMastodonIds(
		Array.from(following.values(), ({ followIri, published }) => ({ iri: followIri, published })),
	);
	const entries = Array.from(following, ([actorIri, { followIri }]) => ({
		actorIri,
		cursorId: followIds.get(followIri),
	})).filter(
		(entry): entry is FollowPageEntry =>
			entry.cursorId !== undefined && isIdInRange(entry.cursorId, page),
	);
	return takePage(entries, (entry) => entry.cursorId, page);
};
