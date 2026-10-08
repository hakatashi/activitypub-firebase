// タイムライン・スレッド用に Note を引くクエリ。apex の Store 契約には含まれない。
import type { APObject } from '../apex/index.js';
import { logger } from 'firebase-functions/v2';
import { Objects } from '../schema.js';

// タイムラインの並べ替え・範囲指定に使うフィールド (→ ADR-0062)。
const PUBLISHED_KEY = '_meta.published';
// 投稿者・返信先の絞り込みに使うフィールド (→ ADR-0086)。
const ATTRIBUTED_TO_KEY = '_meta.attributedTo';
const IN_REPLY_TO_KEY = '_meta.inReplyTo';
// タグでの絞り込みに使うフィールド (→ ADR-0103)。
const HASHTAGS_KEY = '_meta.hashtags';

// タイムライン用に Note を `_meta.published` 順に取得する。`actors` を渡すとその attributedTo のものだけに
// 絞る (Firestore の `in` の制約により FIRESTORE_IN_QUERY_LIMIT 件まで)。`hashtags` を渡すと、正規化したタグ名の
// いずれかを持つものだけに絞る (`array-contains-any`。同じく FIRESTORE_IN_QUERY_LIMIT 件まで。`actors` とは併用できない)。`lower` / `upper` は `_meta.published` の範囲 (両端を含む)。
// `cursor` は読み足し用の `_meta.published` のカーソル (排他。`order` の進行方向の先)。
// 可視性の判定は呼び出し側 (social/visibility.ts の isNoteVisibleTo) の責務。
export const getNotes = async ({
	actors,
	hashtags,
	limit,
	order = 'desc',
	lower,
	upper,
	cursor,
}: {
	actors?: string[] | undefined;
	hashtags?: string[] | undefined;
	limit: number;
	order?: 'asc' | 'desc';
	lower?: string | undefined;
	upper?: string | undefined;
	cursor?: string | undefined;
}): Promise<APObject[]> => {
	logger.info({ type: 'getNotes', actors, hashtags, limit, order, lower, upper, cursor });
	if (
		(actors !== undefined && actors.length === 0) ||
		(hashtags !== undefined && hashtags.length === 0)
	) {
		return [];
	}
	let query = Objects.where('type', '==', 'Note');
	if (actors !== undefined) {
		// attributedTo はローカルの Note では文字列、受信した Note では配列なので、
		// 正規化した写しの `_meta.attributedTo` で引く (→ ADR-0086)。
		query = query.where(ATTRIBUTED_TO_KEY, 'in', actors);
	}
	if (hashtags !== undefined) {
		query = query.where(HASHTAGS_KEY, 'array-contains-any', hashtags);
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

// コンテキスト用に、特定の Note を inReplyTo とする返信 Note を取得する (→ ADR-0064、ADR-0086)。
export const getReplies = async (inReplyTo: string): Promise<APObject[]> => {
	logger.info({ type: 'getReplies', inReplyTo });
	const docs = await Objects.where('type', '==', 'Note')
		.where(IN_REPLY_TO_KEY, '==', inReplyTo)
		.orderBy(PUBLISHED_KEY, 'asc')
		.get();
	return docs.docs.map((doc) => doc.data());
};
