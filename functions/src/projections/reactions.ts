import type { Transaction } from '@google-cloud/firestore';
import firebase from 'firebase-admin';
import { isEqual } from 'lodash-es';
import type { APObject } from '../apex/index.js';
import { db, escapeFirestoreKey } from '../firebase.js';
import { localActorId } from '../localActor.js';
import { getMastodonIds } from '../mastodonId.js';
import { MastodonIdsByIri, ReactionRelations, Streams } from '../schema.js';
import type { ReactionKind, ReactionRelation } from '../schema.js';
import { isAPUndo, toIdArray, toTypeArray } from '../utils.js';

// お気に入り・ブーストの射影 (`userInfos/{ローカル actor}/favourites|reblogs/{Note}`) を、
// Like / Announce の書き換え前後から差分で更新する (→ ADR-0084)。
// Store が、アクティビティを書き換えるのと同じトランザクションの中で呼ぶ。
// `social/` や `mastodon/` を import しないこと。

const ACTIVITY_TYPES = {
	favourites: 'Like',
	reblogs: 'Announce',
} as const satisfies Record<ReactionKind, string>;

const REACTION_KINDS = Object.keys(ACTIVITY_TYPES) as ReactionKind[];

export interface ReactionContribution {
	kind: ReactionKind;
	object: string;
}

// 1 件のアクティビティが、どの射影に載るべきかを返す。ローカル actor 発の Like / Announce だけが対象。
// 取り消しは Undo と同時に元のアクティビティを消すので、存在していれば有効とみなす。
export const reactionContributions = (activity: APObject | undefined): ReactionContribution[] => {
	if (activity === undefined || toIdArray(activity.actor)[0] !== localActorId) {
		return [];
	}
	const types = toTypeArray(activity.type);
	return REACTION_KINDS.filter((kind) => types.includes(ACTIVITY_TYPES[kind])).flatMap((kind) =>
		toIdArray(activity.object).map((object) => ({ kind, object })),
	);
};

const contributionKey = ({ kind, object }: ReactionContribution) => `${kind} ${object}`;

const serverTimestamp = () =>
	firebase.firestore.FieldValue.serverTimestamp() as unknown as ReactionRelation['createdAt'];

// 生きているアクティビティの一覧から射影を組み立てる。一覧が空なら undefined (射影を消す)。
// cursorId は一覧の Mastodon ID の最大値 (= 最新のアクティビティ。→ ADR-0099)。
// oxlint-disable-next-line max-params
const buildReactionRelation = (
	object: string,
	activityIris: string[],
	mastodonIds: ReadonlyMap<string, string>,
	createdAt: ReactionRelation['createdAt'],
): ReactionRelation | undefined => {
	if (activityIris.length === 0) {
		return undefined;
	}
	const ids = activityIris.flatMap((iri) => {
		const id = mastodonIds.get(iri);
		return id === undefined ? [] : [id];
	});
	const cursorId = ids.length === 0 ? null : ids.reduce((a, b) => (a > b ? a : b));
	return { object, activityIris, cursorId, createdAt };
};

const reactionRef = (kind: ReactionKind, object: string) =>
	ReactionRelations(escapeFirestoreKey(localActorId), kind).doc(escapeFirestoreKey(object));

// トランザクション内で、アクティビティ IRI の Mastodon ID を `mastodonIdsByIri` から引く。
const readMastodonIdsInTransaction = async (transaction: Transaction, iris: string[]) => {
	const result = new Map<string, string>();
	const uniqueIris = [...new Set(iris)];
	if (uniqueIris.length === 0) {
		return result;
	}
	const docs = await transaction.getAll(
		...uniqueIris.map((iri) => MastodonIdsByIri.doc(escapeFirestoreKey(iri))),
	);
	uniqueIris.forEach((iri, index) => {
		const mastodonId = docs[index]?.data()?.mastodonId;
		if (mastodonId !== undefined) {
			result.set(iri, mastodonId);
		}
	});
	return result;
};

// トランザクション内で射影の更新を準備する。読み取りだけをここで済ませ、書き込みは戻り値の関数で行う
// (→ ADR-0082 の prepareFollowProjectionUpdate と同じ形)。
// 戻り値の関数には、呼び出し側がこの後に採番したアクティビティの Mastodon ID を渡せる。
// 射影への寄与が書き換え前後で変わらなければ、読み取りもせず undefined を返す。
export const prepareReactionProjectionUpdate = async (
	transaction: Transaction,
	before: APObject | undefined,
	after: APObject | undefined,
): Promise<((mastodonId?: string) => void) | undefined> => {
	const beforeKeys = new Set(reactionContributions(before).map(contributionKey));
	const afterContributions = reactionContributions(after);
	const afterKeys = new Set(afterContributions.map(contributionKey));
	if (isEqual(beforeKeys, afterKeys)) {
		return undefined;
	}
	const activityIri = after?.id ?? before?.id;
	if (activityIri === undefined) {
		return undefined;
	}

	const targets = new Map<string, ReactionContribution>();
	for (const contribution of [...reactionContributions(before), ...afterContributions]) {
		targets.set(contributionKey(contribution), contribution);
	}
	const refs = Array.from(targets.values(), (target) => ({
		...target,
		ref: reactionRef(target.kind, target.object),
	}));
	const docs = await Promise.all(refs.map(({ ref }) => transaction.get(ref)));
	// cursorId を決めるため、射影に残る他のアクティビティと、このアクティビティの Mastodon ID を読む。
	// 同じ Note へのアクティビティが 1 件だけなら、このアクティビティの分だけになる。
	const knownMastodonIds = await readMastodonIdsInTransaction(transaction, [
		activityIri,
		...docs.flatMap((doc) => doc.data()?.activityIris ?? []),
	]);

	return (mastodonId) => {
		const mastodonIds = new Map(knownMastodonIds);
		if (mastodonId !== undefined) {
			mastodonIds.set(activityIri, mastodonId);
		}
		refs.forEach(({ kind, object, ref }, index) => {
			const existing = docs[index]?.data();
			const activityIris = (existing?.activityIris ?? []).filter((iri) => iri !== activityIri);
			if (afterKeys.has(contributionKey({ kind, object }))) {
				activityIris.push(activityIri);
			}
			const relation = buildReactionRelation(
				object,
				activityIris,
				mastodonIds,
				existing?.createdAt ?? serverTimestamp(),
			);
			if (relation === undefined) {
				if (existing !== undefined) {
					transaction.delete(ref);
				}
			} else if (!isEqual(relation, existing)) {
				transaction.set(ref, relation);
			}
		});
	};
};

// 射影には残っているが streams に元のアクティビティがない IRI を、射影から外す。
export const forgetReactionActivity = async (
	kind: ReactionKind,
	object: string,
	activityIri: string,
) => {
	const ref = reactionRef(kind, object);
	await db.runTransaction(async (transaction) => {
		const existing = (await transaction.get(ref)).data();
		if (existing === undefined || !existing.activityIris.includes(activityIri)) {
			return;
		}
		const activityIris = existing.activityIris.filter((iri) => iri !== activityIri);
		const relation = buildReactionRelation(
			object,
			activityIris,
			await readMastodonIdsInTransaction(transaction, activityIris),
			existing.createdAt,
		);
		if (relation === undefined) {
			transaction.delete(ref);
		} else {
			transaction.set(ref, relation);
		}
	});
};

// streams のローカル actor の Like / Announce から射影を書き直す (→ ADR-0084)。バックフィル用。
// ADR-0070 の時期に Undo されたまま残っているアクティビティは除く。
// 射影にない Note のドキュメントは消す。内容が合っているものは書き込まないので、何度実行してもよい。
export const rebuildReactionProjection = async ({ dryRun = false } = {}) => {
	const [undoDocs, ...activityDocs] = await Promise.all([
		Streams.where('type', '==', 'Undo').where('actor', 'array-contains', localActorId).get(),
		...REACTION_KINDS.map((kind) =>
			Streams.where('type', '==', ACTIVITY_TYPES[kind])
				.where('actor', 'array-contains', localActorId)
				.get(),
		),
	]);
	const undoneIris = new Set(
		undoDocs.docs.flatMap((doc) => {
			const undo = doc.data();
			return isAPUndo(undo) ? toIdArray(undo.object) : [];
		}),
	);

	const projection = new Map<string, { kind: ReactionKind; object: string; iris: string[] }>();
	const liveActivities: APObject[] = [];
	for (const snapshot of activityDocs) {
		for (const doc of snapshot.docs) {
			const activity = doc.data();
			if (undoneIris.has(activity.id)) {
				continue;
			}
			liveActivities.push(activity);
			for (const contribution of reactionContributions(activity)) {
				const key = contributionKey(contribution);
				const entry = projection.get(key) ?? { ...contribution, iris: [] };
				entry.iris.push(activity.id);
				projection.set(key, entry);
			}
		}
	}

	// cursorId 用の Mastodon ID (→ ADR-0099)。未採番なら採番する (ADR-0058 と同じ規則)。
	// dry-run では採番せず、採番済みのものだけを使う。
	const mastodonIds = dryRun
		? await db.runTransaction(
				(transaction) =>
					readMastodonIdsInTransaction(
						transaction,
						liveActivities.map((activity) => activity.id),
					),
				{ readOnly: true },
			)
		: await getMastodonIds(
				liveActivities.map((activity) => ({ iri: activity.id, published: activity.published })),
			);

	const userInfoKey = escapeFirestoreKey(localActorId);
	const stats = { written: 0, deleted: 0, favourites: 0, reblogs: 0, skippedUndone: 0 };
	stats.skippedUndone = activityDocs
		.flatMap((snapshot) => snapshot.docs)
		.filter((doc) => undoneIris.has(doc.data().id)).length;
	for (const kind of REACTION_KINDS) {
		const collection = ReactionRelations(userInfoKey, kind);
		const existingDocs = await collection.get();
		const existing = new Map(existingDocs.docs.map((doc) => [doc.id, doc]));
		for (const { object, iris } of [...projection.values()].filter(
			(entry) => entry.kind === kind,
		)) {
			const key = escapeFirestoreKey(object);
			const existingDoc = existing.get(key);
			existing.delete(key);
			const existingRelation = existingDoc?.data();
			const relation = buildReactionRelation(
				object,
				iris.toSorted(),
				mastodonIds,
				existingRelation?.createdAt ?? serverTimestamp(),
			);
			stats[kind]++;
			const unchanged =
				existingRelation !== undefined &&
				isEqual(existingRelation.activityIris.toSorted(), iris.toSorted()) &&
				existingRelation.cursorId === relation?.cursorId;
			if (relation !== undefined && !unchanged) {
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
	return stats;
};
