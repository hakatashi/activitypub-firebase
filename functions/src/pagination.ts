import { z } from 'zod';
import { isMastodonId } from './mastodonId.js';

// カーソルページネーション (→ ADR-0062)。Firestore には触らない。

export interface PageParams {
	limit: number;
	// この ID より小さい (古い) ものだけ返す。
	maxId?: string | undefined;
	// この ID より大きい (新しい) ものだけ返す。新しい側から埋める。
	sinceId?: string | undefined;
	// この ID より大きいものを、カーソルに近い側から順方向に返す。
	minId?: string | undefined;
}

export interface PageLimits {
	defaultLimit: number;
	maxLimit: number;
}

const toId = (value: unknown) =>
	typeof value === 'string' && isMastodonId(value) ? value : undefined;

const limitSchema = z.coerce.number().int();

export const parsePageParams = (
	query: Record<string, unknown>,
	{ defaultLimit, maxLimit }: PageLimits,
): PageParams => {
	const parsedLimit = limitSchema.safeParse(query.limit);
	const limit = parsedLimit.success ? parsedLimit.data : defaultLimit;
	return {
		limit: Math.max(1, Math.min(limit, maxLimit)),
		maxId: toId(query.max_id),
		sinceId: toId(query.since_id),
		minId: toId(query.min_id),
	};
};

// min_id が指定されたら古い側から (カーソルに隣接して) 埋める。
export const isAscending = (page: PageParams) => page.minId !== undefined;

// 下限 (排他) のカーソル。min_id が since_id に優先する。
export const lowerBoundId = (page: PageParams) => page.minId ?? page.sinceId;

export const isIdInRange = (id: string, page: PageParams) => {
	const lower = lowerBoundId(page);
	return (page.maxId === undefined || id < page.maxId) && (lower === undefined || id > lower);
};

// ID の辞書順 (= 大小順) で並べ、カーソルに近い側から limit 件取り、新しい順に直して返す。
export const takePage = <T>(entries: T[], getId: (entry: T) => string, page: PageParams): T[] => {
	const ascending = isAscending(page);
	const sorted = [...entries].sort((a, b) =>
		ascending ? getId(a).localeCompare(getId(b)) : getId(b).localeCompare(getId(a)),
	);
	const taken = sorted.slice(0, page.limit);
	return ascending ? taken.reverse() : taken;
};

const PAGINATION_KEYS = ['max_id', 'since_id', 'min_id'];

// `ids` は応答の並び (新しい順)。空なら Link ヘッダを出さない (クライアントが無限に辿るため)。
export const buildLinkHeader = (
	baseUrl: string,
	query: Record<string, unknown>,
	ids: string[],
): string | undefined => {
	const newest = ids[0];
	const oldest = ids.at(-1);
	if (newest === undefined || oldest === undefined) {
		return undefined;
	}
	const build = (key: 'max_id' | 'min_id', id: string) => {
		const url = new URL(baseUrl);
		for (const [name, value] of Object.entries(query)) {
			if (PAGINATION_KEYS.includes(name)) {
				continue;
			}
			if (typeof value === 'string') {
				url.searchParams.set(name, value);
			} else if (Array.isArray(value)) {
				const paramName = name.endsWith('[]') ? name : `${name}[]`;
				for (const item of value) {
					if (typeof item === 'string') {
						url.searchParams.append(paramName, item);
					}
				}
			}
		}
		url.searchParams.set(key, id);
		return url.toString();
	};
	return `<${build('max_id', oldest)}>; rel="next", <${build('min_id', newest)}>; rel="prev"`;
};
