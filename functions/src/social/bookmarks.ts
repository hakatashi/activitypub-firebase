import { randomInt } from 'node:crypto';
import type { Timestamp } from '@google-cloud/firestore';
import firebase from 'firebase-admin';
import { db, escapeFirestoreKey } from '../firebase.js';
import { buildMastodonId, MAX_SEQUENCE } from '../mastodonId.js';
import { Bookmarks } from '../schema.js';

// ブックマークは AP に対応物がないので、`userInfos/{actor}/bookmarks/{Note}` に直接保存する (→ ADR-0070)。

// ブックマーク一覧のカーソル。時刻から Mastodon ID 形式の値を作る。`mastodonIds` には登録しない。
// 一意である必要があるのは 1 ユーザーのブックマークの中だけなので、同一ミリ秒の衝突はシーケンスの乱数で避ける
// (→ ADR-0099)。
export const buildBookmarkCursorId = (timestamp: number, sequence = randomInt(MAX_SEQUENCE + 1)) =>
	buildMastodonId(timestamp, sequence);

const bookmarkRef = (actorId: string, noteIri: string) =>
	Bookmarks(escapeFirestoreKey(actorId)).doc(escapeFirestoreKey(noteIri));

// 既にブックマーク済みなら何もしない (Mastodon と同じく、元の時刻と並び位置を保つ)。
export const addBookmark = async (actorId: string, noteIri: string) => {
	const ref = bookmarkRef(actorId, noteIri);
	await db.runTransaction(async (transaction) => {
		if ((await transaction.get(ref)).exists) {
			return;
		}
		transaction.set(ref, {
			noteIri,
			cursorId: buildBookmarkCursorId(Date.now()),
			createdAt: firebase.firestore.FieldValue.serverTimestamp() as unknown as Timestamp,
		});
	});
};

export const removeBookmark = async (actorId: string, noteIri: string) => {
	await bookmarkRef(actorId, noteIri).delete();
};

// cursorId がないブックマーク (ADR-0099 より前のもの) に、`createdAt` から cursorId を入れる。バックフィル用。
// 何度実行してもよい。
export const backfillBookmarkCursors = async (actorId: string, { dryRun = false } = {}) => {
	const docs = await Bookmarks(escapeFirestoreKey(actorId)).get();
	const stats = { total: docs.size, written: 0 };
	for (const doc of docs.docs) {
		const bookmark = doc.data();
		if (typeof bookmark.cursorId === 'string') {
			continue;
		}
		const timestamp = bookmark.createdAt?.toMillis() ?? Date.now();
		stats.written++;
		if (!dryRun) {
			await doc.ref.update({ cursorId: buildBookmarkCursorId(timestamp) });
		}
	}
	return stats;
};
