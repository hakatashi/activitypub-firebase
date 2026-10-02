import { describe, expect, test } from 'vitest';
import { buildMastodonId } from '../../src/mastodonId.js';
import {
	buildLinkHeader,
	isIdInRange,
	parsePageParams,
	takePage,
} from '../../src/mastodon/pagination.js';

const limits = { defaultLimit: 20, maxLimit: 40 };
const id = (n: number) => buildMastodonId(1_700_000_000_000 + n, 0);

describe('parsePageParams', () => {
	test('applies default and clamps limit', () => {
		expect(parsePageParams({}, limits).limit).toBe(20);
		expect(parsePageParams({ limit: '5' }, limits).limit).toBe(5);
		expect(parsePageParams({ limit: '1000' }, limits).limit).toBe(40);
		expect(parsePageParams({ limit: '0' }, limits).limit).toBe(1);
		expect(parsePageParams({ limit: '-3' }, limits).limit).toBe(1);
		expect(parsePageParams({ limit: 'abc' }, limits).limit).toBe(20);
	});

	test('reads cursors and ignores malformed ids', () => {
		const page = parsePageParams({ max_id: id(3), since_id: 'abc', min_id: [id(1)] }, limits);
		expect(page.maxId).toBe(id(3));
		expect(page.sinceId).toBeUndefined();
		expect(page.minId).toBeUndefined();
	});
});

describe('takePage', () => {
	const entries = [1, 2, 3, 4, 5].map(id);
	// 範囲の絞り込みは呼び出し側 (isIdInRange) の責務なので、本番と同じ順に適用する。
	const pick = (page: Parameters<typeof takePage>[2]) =>
		takePage(
			entries.filter((entry) => isIdInRange(entry, page)),
			(e) => e,
			page,
		);

	test('max_id fills from the newest below the cursor', () => {
		expect(pick({ limit: 2, maxId: id(4) })).toEqual([id(3), id(2)]);
	});

	test('since_id returns the newest items, leaving a gap', () => {
		expect(pick({ limit: 2, sinceId: id(1) })).toEqual([id(5), id(4)]);
	});

	test('min_id returns the items adjacent to the cursor, newest first', () => {
		expect(pick({ limit: 2, minId: id(1) })).toEqual([id(3), id(2)]);
	});

	test('range is exclusive on both ends', () => {
		expect(isIdInRange(id(3), { limit: 1, maxId: id(3) })).toBe(false);
		expect(isIdInRange(id(3), { limit: 1, sinceId: id(3) })).toBe(false);
		expect(isIdInRange(id(3), { limit: 1, minId: id(2), maxId: id(4) })).toBe(true);
	});
});

describe('buildLinkHeader', () => {
	const base = 'https://mastodon.example/api/v1/timelines/home';

	test('returns undefined for empty results', () => {
		expect(buildLinkHeader(base, {}, [])).toBeUndefined();
	});

	test('builds next from the oldest id and prev from the newest id', () => {
		const link = buildLinkHeader(base, { limit: '2', max_id: id(9) }, [id(5), id(4)]);
		expect(link).toBe(
			`<${base}?limit=2&max_id=${id(4)}>; rel="next", <${base}?limit=2&min_id=${id(5)}>; rel="prev"`,
		);
	});
});
