import { logger } from 'firebase-functions/v2';
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey } from '../firebase.js';
import { Streams } from '../schema.js';

// Follow は to/cc を持たないため apex.isPublic() が常に false になり、承認済みでも
// 匿名の followers コレクションから除外される。承認時にこのフラグを立てて上書きする
// (→ ADR-0035)。
export const markActivityPublic = async (activity: APObject) => {
	const activityRef = Streams.doc(escapeFirestoreKey(activity.id));
	await activityRef.update({ '_meta.isPublic': true });
};

// タイムラインの並べ替え・範囲指定に使うフィールド (→ ADR-0062, ADR-0096)。
const PUBLISHED_KEY = '_meta.published';
// アクターの絞り込みに使うフィールド (→ ADR-0096)。
const ACTOR_KEY = '_meta.actor';

// タイムライン用に Announce (ブースト) を `_meta.published` 順に取得する (→ ADR-0096)。
export const getAnnounces = async ({
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
	logger.info({ type: 'getAnnounces', actors, limit, order, lower, upper, cursor });
	if (actors !== undefined && actors.length === 0) {
		return [];
	}
	let query = Streams.where('type', '==', 'Announce');
	if (actors !== undefined) {
		query = query.where(ACTOR_KEY, 'in', actors);
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
