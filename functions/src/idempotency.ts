import crypto from 'node:crypto';
import firebase from 'firebase-admin';
import { db, toFirestoreKey } from './firebase.js';
import { IdempotencyKeys } from './schema.js';

// `POST /api/v1/statuses` の `Idempotency-Key` を保持する (→ ADR-0063)。
// Mastodon と同じく1時間保持する (`third_party/mastodon/app/services/post_status_service.rb`)。
export const IDEMPOTENCY_KEY_TTL_MS = 60 * 60 * 1000;

// キーはクライアントが任意に決める文字列なので、ドキュメント ID にはハッシュを使う。
// actor ごとに名前空間を分ける (Mastodon も account ID をキーに含める)。
const toDocId = (actorId: string, key: string) =>
	toFirestoreKey(crypto.createHash('sha256').update(`${actorId}\n${key}`).digest('hex'));

export type IdempotencyReservation =
	| { type: 'reserved'; release: () => Promise<void> }
	| { type: 'duplicate'; noteIri: string };

// キーに `noteIri` を予約する。期限内の予約が既にあれば、その `noteIri` を返す。
// 予約は Note を作る前に行い、作成に失敗したら `release` で取り消すこと。
export const reserveIdempotencyKey = async ({
	actorId,
	key,
	noteIri,
	now = Date.now(),
}: {
	actorId: string;
	key: string;
	noteIri: string;
	now?: number;
}): Promise<IdempotencyReservation> => {
	const ref = IdempotencyKeys.doc(toDocId(actorId, key));
	const existing = await db.runTransaction(async (transaction) => {
		const doc = await transaction.get(ref);
		const record = doc.data();
		// TTL ポリシーによる削除は遅れうるため、期限は読み出し時にも判定する。
		if (record !== undefined && record.expiresAt.toMillis() > now) {
			return record.noteIri;
		}
		transaction.set(ref, {
			actorId,
			noteIri,
			expiresAt: firebase.firestore.Timestamp.fromMillis(now + IDEMPOTENCY_KEY_TTL_MS),
		});
		return undefined;
	});

	if (existing !== undefined) {
		return { type: 'duplicate', noteIri: existing };
	}
	return {
		type: 'reserved',
		release: async () => {
			await ref.delete();
		},
	};
};
