import { readTimelineHeadState } from '../../social/timelines.js';
import type { TimelineTarget } from '../../social/timelines.js';
import type { PageParams } from '../pagination.js';
import type { StatusEntity } from './status.js';

// ホーム・リストのタイムラインの先頭ページを、組み立て済みの Status のままインスタンス内にキャッシュする (→ ADR-0139)。

interface TimelineHeadCacheEntry {
	version: string;
	latestEntryId: string | null;
	// 全体を組み立てた時刻。新着を足しても更新しない (→ ADR-0139 決定5)
	builtAt: number;
	statuses: StatusEntity[];
}

// キーは閲覧者・タイムライン・limit。Map の挿入順を LRU に使う。
const cache = new Map<string, TimelineHeadCacheEntry>();

const MAX_ENTRIES = 32;
// リモートで変わる件数・編集・削除などを読み直すまでの時間。
const MAX_AGE_MS = 15 * 60 * 1000;

export const clearTimelineHeadCache = () => {
	cache.clear();
};

const remember = (key: string, entry: TimelineHeadCacheEntry) => {
	cache.delete(key);
	cache.set(key, entry);
	for (const oldest of cache.keys()) {
		if (cache.size <= MAX_ENTRIES) {
			break;
		}
		cache.delete(oldest);
	}
};

// 新着の Status を前回の先頭ページに足す。ID の重複は新しく組み立てた方を、同じ Note のブーストは新しい方を残す
// (→ ADR-0096、ADR-0139 決定4)。
const mergeStatuses = (fresh: StatusEntity[], cached: StatusEntity[], limit: number) => {
	const byId = new Map([...cached, ...fresh].map((status) => [status.id, status]));
	const seenReblogs = new Set<string>();
	return [...byId.values()]
		.sort((a, b) => b.id.localeCompare(a.id))
		.filter((status) => {
			if (status.reblog === null) {
				return true;
			}
			if (seenReblogs.has(status.reblog.id)) {
				return false;
			}
			seenReblogs.add(status.reblog.id);
			return true;
		})
		.slice(0, limit);
};

// 先頭ページ (カーソルなし) なら、キャッシュを検証して返す。新着があれば新着分だけを `build` で組み立てて足す。
// それ以外のページや、キャッシュできない状態なら毎回 `build` する。
export const withTimelineHeadCache = async ({
	viewerId,
	target,
	page,
	build,
}: {
	viewerId: string;
	target: TimelineTarget;
	page: PageParams;
	build: (page: PageParams) => Promise<StatusEntity[]>;
}): Promise<StatusEntity[]> => {
	if (page.maxId !== undefined || page.sinceId !== undefined || page.minId !== undefined) {
		return build(page);
	}
	const state = await readTimelineHeadState(viewerId, target);
	if (state === undefined) {
		return build(page);
	}
	const key = [
		viewerId,
		target.kind === 'home' ? 'home' : `list ${target.listId}`,
		page.limit,
	].join('\n');
	const cached = cache.get(key);
	if (
		cached !== undefined &&
		cached.version === state.version &&
		Date.now() - cached.builtAt < MAX_AGE_MS
	) {
		if (cached.latestEntryId === state.latestEntryId) {
			remember(key, cached);
			return [...cached.statuses];
		}
		if (
			cached.latestEntryId !== null &&
			state.latestEntryId !== null &&
			state.latestEntryId > cached.latestEntryId
		) {
			const fresh = await build({ limit: page.limit, sinceId: cached.latestEntryId });
			const merged = mergeStatuses(fresh, cached.statuses, page.limit);
			if (merged.length >= Math.min(page.limit, cached.statuses.length)) {
				remember(key, { ...cached, latestEntryId: state.latestEntryId, statuses: merged });
				return [...merged];
			}
		}
	}
	const builtAt = Date.now();
	const statuses = await build(page);
	remember(key, { ...state, builtAt, statuses });
	return [...statuses];
};
