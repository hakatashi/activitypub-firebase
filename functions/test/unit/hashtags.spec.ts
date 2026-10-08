import { describe, expect, test } from 'vitest';
import { getObjectHashtags, normalizeHashtag, toHashtagDisplayName } from '../../src/hashtags.js';

// タグ名の正規化 (→ ADR-0103)。
describe('hashtags', () => {
	describe('normalizeHashtag', () => {
		test.each([
			['#Foo', 'foo'],
			['foo', 'foo'],
			['＃ＦＯＯ', 'foo'],
			['#ﾊｯｼｭﾀｸﾞ', 'ハッシュタグ'],
			['#日本語', '日本語'],
			['#foo_bar', 'foo_bar'],
			['#foo-bar!', 'foobar'],
			['#Café', 'café'],
		])('%s -> %s', (input, expected) => {
			expect(normalizeHashtag(input)).toBe(expected);
		});

		test('returns undefined for empty names', () => {
			expect(normalizeHashtag('#')).toBeUndefined();
			expect(normalizeHashtag('!!')).toBeUndefined();
		});
	});

	describe('toHashtagDisplayName', () => {
		test('keeps the case and strips # and invalid characters', () => {
			expect(toHashtagDisplayName('#FooBar')).toBe('FooBar');
			expect(toHashtagDisplayName('＃Foo-Bar')).toBe('FooBar');
			expect(toHashtagDisplayName('#')).toBeUndefined();
		});
	});

	describe('getObjectHashtags', () => {
		test('collects unique normalized Hashtag names', () => {
			expect(
				getObjectHashtags({
					tag: [
						{ type: 'Hashtag', name: '#Foo' },
						{ type: ['Hashtag'], name: ['#foo'] },
						{ type: 'Hashtag', name: '#bar' },
						{ type: 'Mention', name: '@baz' },
						{ type: 'Hashtag' },
						'https://example.com/tags/qux',
					],
				}),
			).toEqual(['foo', 'bar']);
		});

		test('accepts a single tag object', () => {
			expect(getObjectHashtags({ tag: { type: 'Hashtag', name: '#Foo' } })).toEqual(['foo']);
			expect(getObjectHashtags({})).toEqual([]);
		});
	});
});
