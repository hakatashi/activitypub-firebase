// タイムライン・スレッド用に Note を引くクエリ。apex の Store 契約には含まれない。
import type { APObject } from '../apex/index.js';
import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { Objects } from '../schema.js';

// タイムラインの並べ替え・範囲指定に使うフィールド (→ ADR-0062)。
const PUBLISHED_KEY = '_meta.published';

// タイムライン用に Note を `_meta.published` 順に取得する。`actors` を渡すとその attributedTo のものだけに
// 絞る (Firestore の選言数の制約により NOTE_AUTHORS_QUERY_LIMIT 件まで)。`lower` / `upper` は `_meta.published` の範囲 (両端を含む)。
// `cursor` は読み足し用の `_meta.published` のカーソル (排他。`order` の進行方向の先)。
// 可視性の判定は呼び出し側 (social/visibility.ts の isNoteVisibleTo) の責務。
export const getNotes = async ({
	actors,
	limit,
	order = 'desc',
	lower,
	upper,
	cursor,
}: {
	actors?: string[] | undefined;
	limit: number;
	order?: 'asc' | 'desc';
	lower?: string | undefined;
	upper?: string | undefined;
	cursor?: string | undefined;
}): Promise<APObject[]> => {
	logger.info({ type: 'getNotes', actors, limit, order, lower, upper, cursor });
	if (actors !== undefined && actors.length === 0) {
		return [];
	}
	let query = Objects.where('type', '==', 'Note');
	if (actors !== undefined) {
		// ローカルの Note は attributedTo が文字列、inbox で受けたリモートの Note は apex が
		// 配列に正規化して保存するため、両方の形式に一致させる (→ ADR-0072)。
		query = query.where(
			firebase.firestore.Filter.or(
				firebase.firestore.Filter.where('attributedTo', 'in', actors),
				firebase.firestore.Filter.where('attributedTo', 'array-contains-any', actors),
			),
		);
	}
	if (lower !== undefined) {
		query = query.where(PUBLISHED_KEY, '>=', lower);
	}
	if (upper !== undefined) {
		query = query.where(PUBLISHED_KEY, '<=', upper);
	}
	query = query.orderBy(PUBLISHED_KEY, order);
	if (cursor !== undefined) {
		query = query.startAfter(cursor);
	}
	const docs = await query.limit(limit).get();
	return docs.docs.map((doc) => doc.data());
};

// コンテキスト用に、特定の Note を inReplyTo とする返信 Note を取得する (→ ADR-0064)。
export const getReplies = async (inReplyTo: string): Promise<APObject[]> => {
	logger.info({ type: 'getReplies', inReplyTo });
	const docs = await Objects.where('type', '==', 'Note')
		.where(
			firebase.firestore.Filter.or(
				firebase.firestore.Filter.where('inReplyTo', '==', inReplyTo),
				firebase.firestore.Filter.where('inReplyTo', 'array-contains', inReplyTo),
			),
		)
		.orderBy(PUBLISHED_KEY, 'asc')
		.get();
	return docs.docs.map((doc) => doc.data());
};
