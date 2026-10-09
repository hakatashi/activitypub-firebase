// 返信数の非正規化カウンタ `_meta.repliesCount` (→ ADR-0102)。Store が `objects` を書き換える
// トランザクション内で、書き換え前後の差分から返信先 Note の件数を増減する。
import type { Transaction } from '@google-cloud/firestore';
import { noteToVisibility } from '../addressing.js';
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey } from '../firebase.js';
import { toObjectQueryMetaValue } from '../meta.js';
import { Objects } from '../schema.js';
import { isAPNote } from '../utils.js';

// 返信を `_meta.inReplyTo` で引く (→ ADR-0086)。
const IN_REPLY_TO_KEY = '_meta.inReplyTo';

// object が返信数に数える返信なら、その返信先の IRI を返す。Tombstone・自分自身への返信・
// `direct` の返信は数えない (Mastodon の `Status#increment_counter_caches` と同じ)。
// `_meta.inReplyTo` は書き換え前のドキュメントで欠けていることがあるので、生の `inReplyTo` から計算する。
export const getCountedReplyTarget = (object: APObject | undefined): string | undefined => {
	if (object === undefined || !isAPNote(object)) {
		return undefined;
	}
	const inReplyTo = toObjectQueryMetaValue('inReplyTo', object.inReplyTo);
	if (inReplyTo === undefined || inReplyTo === object.id) {
		return undefined;
	}
	if (noteToVisibility(object) === 'direct') {
		return undefined;
	}
	return inReplyTo;
};

export interface RepliesCountUpdate {
	// 新規に保存する Note 自身の `_meta.repliesCount` の初期値。既存の返信が無ければ未指定。
	meta?: { repliesCount: number };
	// 返信先の `_meta.repliesCount` を書き込む。トランザクションの読み取りをすべて終えた後に呼ぶ。
	commit: () => void;
}

// Firestore のトランザクションは「すべての読み取りの後に書き込み」を要求するため、読み取りだけを
// 先に済ませ、返信先への書き込みは戻り値の `commit` で行う (projections/index.ts と同じ形)。
// `before` が無い (新規保存) ときは、手元に既にある返信を数えて自身の初期値を返す。
export const prepareRepliesCountUpdate = async (
	transaction: Transaction,
	before: APObject | undefined,
	after: APObject | undefined,
): Promise<RepliesCountUpdate> => {
	const deltas = new Map<string, number>();
	const beforeTarget = getCountedReplyTarget(before);
	const afterTarget = getCountedReplyTarget(after);
	// 返信先が変わらなければ増減しない。同じ返信を何度保存しても数え直さない。
	if (beforeTarget !== afterTarget) {
		if (beforeTarget !== undefined) {
			deltas.set(beforeTarget, -1);
		}
		if (afterTarget !== undefined) {
			deltas.set(afterTarget, 1);
		}
	}

	const [targetDocs, existingReplies] = await Promise.all([
		Promise.all(
			Array.from(deltas, async ([iri, delta]) => {
				const ref = Objects.doc(escapeFirestoreKey(iri));
				return { ref, delta, doc: await transaction.get(ref) };
			}),
		),
		before === undefined && after?.id !== undefined && isAPNote(after)
			? transaction.get(Objects.where(IN_REPLY_TO_KEY, '==', after.id))
			: undefined,
	]);

	const initialCount = existingReplies?.docs.filter(
		(doc) => getCountedReplyTarget(doc.data()) === after?.id,
	).length;

	return {
		...(initialCount === undefined || initialCount === 0
			? {}
			: { meta: { repliesCount: initialCount } }),
		commit: () => {
			for (const { ref, delta, doc } of targetDocs) {
				// 返信先が手元に無ければ数えない。後から保存されたときに初期値として数える。
				if (!doc.exists) {
					continue;
				}
				// 0 未満にはしない (→ ADR-0053)。
				const current = doc.data()?._meta?.repliesCount ?? 0;
				transaction.update(ref, { '_meta.repliesCount': Math.max(0, current + delta) });
			}
		},
	};
};
