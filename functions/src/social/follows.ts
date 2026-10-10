import assert from 'node:assert';
import type { Query } from '@google-cloud/firestore';
import type { APActor } from 'activitypub-types';
import { logger } from 'firebase-functions/v2';
import type { APObject } from '../apex/index.js';
import { apex } from '../apex.js';
import { db, escapeFirestoreKey } from '../firebase.js';
import { localActorId, localFollowersId, localInboxId } from '../localActor.js';
import { metaIndexPath } from '../meta.js';
import type { PageParams } from '../pagination.js';
import { isAscending, lowerBoundId } from '../pagination.js';
import { FollowRelations, Streams } from '../schema.js';
import type { FollowRelation, FollowRelationSide } from '../schema.js';
import { markActivityPublic } from '../store/activities.js';
import { toIdArray } from '../utils.js';

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

// viewer から相手への代表の Follow (承認待ちを含む) の IRI を返す。射影になければ undefined。
export const getFollowIri = async (
	viewer: APActor,
	targetIri: string,
): Promise<string | undefined> =>
	(await relations(viewer, 'following').doc(escapeFirestoreKey(targetIri)).get()).data()?.followIri;

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

// Follow の自動承認と Accept の送信を行う (ADR-0111)。
// onApexInbox と reconcilePendingFollows で共有する。
export const acceptAndPublishFollow = async (
	recipient: APObject,
	follow: APObject,
): Promise<void> => {
	const followerId = toIdArray(follow.actor)[0];
	assert(followerId !== undefined, 'followerId is undefined');
	assert(recipient.id !== undefined, 'recipient.id is undefined');

	logger.info(`New follow request from ${followerId}`);

	// 同じ相手からの再 Follow は古い Follow を置き換える (→ ADR-0075)。
	const superseded = await removeSupersededFollows(followerId, recipient.id, follow.id);
	if (superseded > 0) {
		logger.info(`Removed ${superseded} superseded follow(s) from ${followerId}`);
	}

	const object = { ...follow };
	delete object._meta;

	const accept = await apex.buildActivity('Accept', recipient.id, followerId, {
		object,
	});
	const { postTask: publishUpdatedFollowers } = await apex.acceptFollow(recipient, follow);
	// Follow は to/cc を持たないため、明示的に isPublic を立てないと匿名の
	// followers コレクションから除外されてしまう (→ ADR-0035)。
	await markActivityPublic(follow);

	logger.info(`Accepting follow request from ${followerId}`);
	await apex.addToOutbox(recipient, accept);

	logger.info('Publishing updated followers');
	await publishUpdatedFollowers();

	logger.info(`Follow request from ${followerId} accepted`);
};

export interface ReconcilePendingFollowsOptions {
	dryRun?: boolean;
}

export interface ReconcilePendingFollowsResult {
	scannedCount: number;
	pendingFollows: {
		id: string;
		actor: string;
	}[];
	reconciledCount: number;
}

// inbox にあり followers に入っていない未承認 Follow を見つけて承認する (ADR-0111)。
export const reconcilePendingFollows = async (
	options: ReconcilePendingFollowsOptions = {},
): Promise<ReconcilePendingFollowsResult> => {
	const { dryRun = false } = options;

	const localActor = await apex.store.getObject(localActorId, true);
	assert(localActor !== undefined, 'localActor is undefined');

	const docs = await Streams.where('type', '==', 'Follow')
		.where('_meta.collection', 'array-contains', localInboxId)
		.get();

	const pendingDocs = docs.docs.filter((doc) => {
		const follow = doc.data();
		const objectId = toIdArray(follow.object)[0];
		if (objectId !== localActorId) {
			return false;
		}
		const collections = toIdArray(follow._meta?.collection);
		return !collections.includes(localFollowersId);
	});

	const pendingFollows = pendingDocs.map((doc) => {
		const data = doc.data();
		return {
			id: data.id,
			actor: toIdArray(data.actor)[0] ?? '',
		};
	});

	if (dryRun) {
		return {
			scannedCount: docs.docs.length,
			pendingFollows,
			reconciledCount: 0,
		};
	}

	for (const doc of pendingDocs) {
		await acceptAndPublishFollow(localActor, doc.data());
	}

	return {
		scannedCount: docs.docs.length,
		pendingFollows,
		reconciledCount: pendingDocs.length,
	};
};
