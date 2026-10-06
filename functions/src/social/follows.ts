import assert from 'node:assert';
import type { Query } from '@google-cloud/firestore';
import type { APActor } from 'activitypub-types';
import { apex } from '../apex.js';
import { db, escapeFirestoreKey } from '../firebase.js';
import { metaIndexPath } from '../meta.js';
import type { PageParams } from '../pagination.js';
import { isAscending, lowerBoundId } from '../pagination.js';
import { FollowRelations, Streams } from '../schema.js';
import type { FollowRelation, FollowRelationSide } from '../schema.js';

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

export interface FollowPageEntry {
	actorIri: string;
	cursorId: string;
}

// フォロー関係は、ローカル actor ごとの射影 (`userInfos/{actor}/following|followers/{相手}`) から読む
// (→ ADR-0082, ADR-0083)。射影はローカル actor の分しかないので、リモートの actor を渡すと空になる。
const relations = (actor: APActor, side: FollowRelationSide) => {
	assert(actor.id !== undefined, 'actor.id is undefined');
	return FollowRelations(escapeFirestoreKey(actor.id), side);
};

const toActorIris = (docs: { data: () => FollowRelation }[]) => docs.map((doc) => doc.data().actor);

// viewer がフォロー中 (相手が Accept 済み) の actor IRI の配列を返す。
export const getFollowing = async (actor: APActor): Promise<string[]> =>
	toActorIris((await relations(actor, 'following').where('state', '==', 'accepted').get()).docs);

// 送信した Follow のうち、相手が未 Accept の対象 actor IRI の集合を返す。
export const getPendingFollowTargetIris = async (actor: APActor): Promise<Set<string>> =>
	new Set(
		toActorIris((await relations(actor, 'following').where('state', '==', 'pending').get()).docs),
	);

// フォロワーの actor IRI の配列を返す。
export const getFollowerActorIris = async (actor: APActor): Promise<string[]> =>
	toActorIris((await relations(actor, 'followers').get()).docs);

export interface FollowFlags {
	following: boolean;
	requested: boolean;
	followedBy: boolean;
}

// viewer と各相手との関係 (Mastodon の Relationship の following / requested / followed_by) を、
// 相手ごとの射影ドキュメントを直接引いて判定する。戻り値は `targetIris` と同じ並び。
export const getFollowFlags = async (
	viewer: APActor,
	targetIris: string[],
): Promise<FollowFlags[]> => {
	if (targetIris.length === 0) {
		return [];
	}
	const refs = (side: FollowRelationSide) =>
		targetIris.map((iri) => relations(viewer, side).doc(escapeFirestoreKey(iri)));
	const [followingDocs, followerDocs] = await Promise.all([
		db.getAll(...refs('following')),
		db.getAll(...refs('followers')),
	]);
	return targetIris.map((_, index) => {
		const state = followingDocs[index]?.get('state') as FollowRelation['state'] | undefined;
		return {
			following: state === 'accepted',
			requested: state === 'pending',
			followedBy: followerDocs[index]?.exists === true,
		};
	});
};

// カーソルは Follow アクティビティの Mastodon ID (Mastodon の follow 行 ID に相当。→ ADR-0062)。
// 射影の `followMastodonId` で並べ、範囲と件数も Firestore 側で絞る。応答は新しい順。
const getFollowPageEntries = async (
	actor: APActor,
	side: FollowRelationSide,
	page: PageParams,
): Promise<FollowPageEntry[]> => {
	const ascending = isAscending(page);
	const lower = lowerBoundId(page);
	let query: Query<FollowRelation> = relations(actor, side);
	if (side === 'following') {
		query = query.where('state', '==', 'accepted');
	}
	if (page.maxId !== undefined) {
		query = query.where('followMastodonId', '<', page.maxId);
	}
	// followMastodonId が null の射影 (Mastodon ID が未採番) はカーソルにできないので除く。
	// 文字列の範囲条件は null に一致しない。
	query = query.where('followMastodonId', '>', lower ?? '');
	const docs = await query
		.orderBy('followMastodonId', ascending ? 'asc' : 'desc')
		.limit(page.limit)
		.get();
	const entries = docs.docs.map((doc) => {
		const { actor: actorIri, followMastodonId } = doc.data();
		assert(followMastodonId !== null, 'followMastodonId is null');
		return { actorIri, cursorId: followMastodonId };
	});
	return ascending ? entries.reverse() : entries;
};

export const getFollowersPageEntries = (actor: APActor, page: PageParams = { limit: 40 }) =>
	getFollowPageEntries(actor, 'followers', page);

export const getFollowingPageEntries = (actor: APActor, page: PageParams = { limit: 40 }) =>
	getFollowPageEntries(actor, 'following', page);
