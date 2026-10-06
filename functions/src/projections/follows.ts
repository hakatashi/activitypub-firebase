import assert from 'node:assert';
import type { Transaction } from '@google-cloud/firestore';
import firebase from 'firebase-admin';
import { isEqual } from 'lodash-es';
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey } from '../firebase.js';
import {
	localActorId,
	localFollowersId,
	localFollowingId,
	localRejectionsId,
} from '../localActor.js';
import { getMastodonIds } from '../mastodonId.js';
import { FollowRelations, MastodonIdsByIri, Streams, UserInfos } from '../schema.js';
import type {
	FollowRelation,
	FollowRelationEntry,
	FollowRelationSide,
	FollowState,
	UserInfo,
} from '../schema.js';
import { toIdArray, toTypeArray } from '../utils.js';

// フォロー関係の射影 (`userInfos/{ローカル actor}/following|followers/{相手}`) を、
// Follow アクティビティの書き換え前後から差分で更新する (→ ADR-0082)。
// Store (と Follow を直接消す処理) が、Follow を書き換えるのと同じトランザクションの中で呼ぶ。
// `social/` や `mastodon/` を import しないこと。

export interface FollowContribution {
	side: FollowRelationSide;
	counterpart: string;
	state: FollowState;
}

const COUNTER_FIELDS = {
	followers: 'followers_count',
	following: 'following_count',
} as const satisfies Record<FollowRelationSide, keyof UserInfo>;

// 1 件の Follow が、どの射影にどの状態で載るべきかを返す。判定基準は apex が管理する
// `_meta.collection` への所属で、apex 自身の followers / following コレクションと一致する。
export const followContributions = (follow: APObject | undefined): FollowContribution[] => {
	if (follow === undefined || !toTypeArray(follow.type).includes('Follow')) {
		return [];
	}
	const follower = toIdArray(follow.actor)[0];
	const followee = toIdArray(follow.object)[0];
	if (follower === undefined || followee === undefined) {
		return [];
	}
	const collections = toIdArray(follow._meta?.collection);
	const contributions: FollowContribution[] = [];
	if (follower === localActorId && !collections.includes(localRejectionsId)) {
		contributions.push({
			side: 'following',
			counterpart: followee,
			state: collections.includes(localFollowingId) ? 'accepted' : 'pending',
		});
	}
	if (followee === localActorId && collections.includes(localFollowersId)) {
		contributions.push({ side: 'followers', counterpart: follower, state: 'accepted' });
	}
	return contributions;
};

const isCounted = (side: FollowRelationSide, relation: FollowRelation | undefined) =>
	relation !== undefined && (side === 'followers' || relation.state === 'accepted');

const compareEntries = (a: FollowRelationEntry, b: FollowRelationEntry) => {
	if (a.state !== b.state) {
		return a.state === 'accepted' ? -1 : 1;
	}
	return (b.mastodonId ?? '').localeCompare(a.mastodonId ?? '');
};

// 相手への Follow の一覧から射影を組み立てる。一覧が空なら undefined (射影を消す)。
export const buildFollowRelation = (
	counterpart: string,
	follows: FollowRelationEntry[],
	createdAt: FollowRelation['createdAt'],
): FollowRelation | undefined => {
	const [representative] = follows.toSorted(compareEntries);
	if (representative === undefined) {
		return undefined;
	}
	return {
		actor: counterpart,
		followIri: representative.iri,
		followMastodonId: representative.mastodonId,
		state: representative.state,
		createdAt,
		follows,
	};
};

const relationKey = (side: FollowRelationSide, counterpart: string) => `${side} ${counterpart}`;

// トランザクション内で射影の更新を準備する。Firestore のトランザクションは「すべての読み取りの後に
// 書き込み」を要求するため、読み取りだけをここで済ませ、書き込みは戻り値の関数で行う。
// 戻り値の関数には、呼び出し側がこの後に採番した Follow の Mastodon ID を渡せる。
// Follow でない・ローカル actor に関係しない書き換えなら undefined を返す。
export const prepareFollowProjectionUpdate = async (
	transaction: Transaction,
	before: APObject | undefined,
	after: APObject | undefined,
): Promise<((followMastodonId?: string) => void) | undefined> => {
	const beforeContributions = followContributions(before);
	const afterContributions = followContributions(after);
	if (beforeContributions.length === 0 && afterContributions.length === 0) {
		return undefined;
	}
	const followIri = after?.id ?? before?.id;
	assert(followIri !== undefined, 'follow id is undefined');

	const targets = new Map<string, { side: FollowRelationSide; counterpart: string }>();
	for (const { side, counterpart } of [...beforeContributions, ...afterContributions]) {
		targets.set(relationKey(side, counterpart), { side, counterpart });
	}

	const userInfoKey = escapeFirestoreKey(localActorId);
	const userInfoRef = UserInfos.doc(userInfoKey);
	const byIriRef = MastodonIdsByIri.doc(escapeFirestoreKey(followIri));
	const relationRefs = Array.from(targets.values(), ({ side, counterpart }) => ({
		side,
		counterpart,
		ref: FollowRelations(userInfoKey, side).doc(escapeFirestoreKey(counterpart)),
	}));
	const [userInfoDoc, byIriDoc, relationDocs] = await Promise.all([
		transaction.get(userInfoRef),
		transaction.get(byIriRef),
		Promise.all(relationRefs.map(({ ref }) => transaction.get(ref))),
	]);
	const knownMastodonId = byIriDoc.data()?.mastodonId;

	return (followMastodonId) => {
		const counterDeltas: Record<FollowRelationSide, number> = { followers: 0, following: 0 };

		relationRefs.forEach(({ side, counterpart, ref }, index) => {
			const existing = relationDocs[index]?.data();
			const existingFollows = existing?.follows ?? [];
			const previousEntry = existingFollows.find((entry) => entry.iri === followIri);
			const contribution = afterContributions.find(
				(candidate) => candidate.side === side && candidate.counterpart === counterpart,
			);
			const follows = existingFollows.filter((entry) => entry.iri !== followIri);
			if (contribution !== undefined) {
				follows.push({
					iri: followIri,
					state: contribution.state,
					mastodonId: followMastodonId ?? knownMastodonId ?? previousEntry?.mastodonId ?? null,
				});
			}
			const relation = buildFollowRelation(
				counterpart,
				follows,
				existing?.createdAt ??
					(firebase.firestore.FieldValue.serverTimestamp() as unknown as FollowRelation['createdAt']),
			);

			if (relation === undefined) {
				if (existing !== undefined) {
					transaction.delete(ref);
				}
			} else if (!isEqual(relation, existing)) {
				transaction.set(ref, relation);
			}

			counterDeltas[side] += Number(isCounted(side, relation)) - Number(isCounted(side, existing));
		});

		const userInfo = userInfoDoc.data();
		if (userInfo === undefined) {
			return;
		}
		const updates: Partial<Record<(typeof COUNTER_FIELDS)[FollowRelationSide], number>> = {};
		for (const side of ['followers', 'following'] as const) {
			if (counterDeltas[side] !== 0) {
				const field = COUNTER_FIELDS[side];
				updates[field] = Math.max(0, (userInfo[field] ?? 0) + counterDeltas[side]);
			}
		}
		if (Object.keys(updates).length > 0) {
			transaction.update(userInfoRef, updates);
		}
	};
};

export type FollowProjection = Record<FollowRelationSide, Map<string, FollowRelationEntry[]>>;

// Follow の一覧から、射影の全体 (相手ごとの Follow の一覧) を組み立てる。差分更新と同じ
// followContributions を使うので、バックフィルの結果はその後の差分更新と食い違わない。
export const buildFollowProjection = (
	follows: APObject[],
	mastodonIds: Map<string, string>,
): FollowProjection => {
	const projection: FollowProjection = { followers: new Map(), following: new Map() };
	for (const follow of follows) {
		for (const { side, counterpart, state } of followContributions(follow)) {
			const entries = projection[side].get(counterpart) ?? [];
			entries.push({ iri: follow.id, state, mastodonId: mastodonIds.get(follow.id) ?? null });
			projection[side].set(counterpart, entries);
		}
	}
	return projection;
};

// streams の全 Follow から射影とカウンタを書き直す (→ ADR-0082)。バックフィル用。
// 射影にない相手のドキュメントは消す。内容が合っているものは書き込まないので、何度実行してもよい。
export const rebuildFollowProjection = async ({ dryRun = false } = {}) => {
	const followDocs = await Streams.where('type', '==', 'Follow').get();
	const follows = followDocs.docs
		.map((doc) => doc.data())
		.filter((follow) => followContributions(follow).length > 0);
	const mastodonIds = await getMastodonIds(
		follows.map((follow) => ({ iri: follow.id, published: follow.published })),
	);
	const projection = buildFollowProjection(follows, mastodonIds);

	const userInfoKey = escapeFirestoreKey(localActorId);
	const stats = { written: 0, deleted: 0, followers: 0, following: 0 };
	for (const side of ['followers', 'following'] as const) {
		const collection = FollowRelations(userInfoKey, side);
		const existingDocs = await collection.get();
		const existing = new Map(existingDocs.docs.map((doc) => [doc.id, doc]));
		for (const [counterpart, entries] of projection[side]) {
			const key = escapeFirestoreKey(counterpart);
			const existingDoc = existing.get(key);
			existing.delete(key);
			const existingRelation = existingDoc?.data();
			const relation = buildFollowRelation(
				counterpart,
				entries,
				existingRelation?.createdAt ??
					(firebase.firestore.FieldValue.serverTimestamp() as unknown as FollowRelation['createdAt']),
			);
			assert(relation !== undefined);
			if (isCounted(side, relation)) {
				stats[side]++;
			}
			if (!isEqual(relation, existingRelation)) {
				stats.written++;
				if (!dryRun) {
					await collection.doc(key).set(relation);
				}
			}
		}
		for (const doc of existing.values()) {
			stats.deleted++;
			if (!dryRun) {
				await doc.ref.delete();
			}
		}
	}

	const userInfoRef = UserInfos.doc(userInfoKey);
	const userInfo = (await userInfoRef.get()).data();
	if (
		!dryRun &&
		userInfo !== undefined &&
		(userInfo.followers_count !== stats.followers || userInfo.following_count !== stats.following)
	) {
		await userInfoRef.update({
			followers_count: stats.followers,
			following_count: stats.following,
		});
	}
	return stats;
};
