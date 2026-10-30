import { afterEach, describe, expect, test, vi } from 'vitest';
import { clonePlain, createTtlCache } from '../../src/mastodon/http/instanceCache.js';

describe('createTtlCache', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('expires entries after maxAgeMs without extending on read', () => {
		vi.useFakeTimers();
		const cache = createTtlCache<number>({ maxEntries: 10, maxAgeMs: 1000 });
		cache.set('a', 1);
		vi.advanceTimersByTime(600);
		expect(cache.get('a')).toBe(1);
		vi.advanceTimersByTime(400);
		expect(cache.get('a')).toBeUndefined();
	});

	test('evicts the least recently used entry over maxEntries', () => {
		const cache = createTtlCache<number>({ maxEntries: 2, maxAgeMs: 1000 });
		cache.set('a', 1);
		cache.set('b', 2);
		cache.get('a');
		cache.set('c', 3);
		expect(cache.get('a')).toBe(1);
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('c')).toBe(3);
	});

	test('deletes entries matching a predicate', () => {
		const cache = createTtlCache<number>({ maxEntries: 10, maxAgeMs: 1000 });
		cache.set('a', 1);
		cache.set('b', 2);
		cache.deleteWhere((value) => value === 1);
		expect(cache.get('a')).toBeUndefined();
		expect(cache.get('b')).toBe(2);
	});
});

describe('clonePlain', () => {
	test('copies plain objects and arrays but shares class instances', () => {
		const date = new Date(0);
		const original = { a: { b: [1, { c: 2 }] }, date };
		const cloned = clonePlain(original);
		expect(cloned).toEqual(original);
		expect(cloned.a).not.toBe(original.a);
		expect(cloned.a.b).not.toBe(original.a.b);
		expect(cloned.date).toBe(date);
	});
});
