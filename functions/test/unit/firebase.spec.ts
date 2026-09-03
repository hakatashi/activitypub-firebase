import {describe, expect, test} from 'vitest';
import {escapeFirestoreKey, unescapeFirestoreKey} from '../../src/firebase.js';

describe('escapeFirestoreKey', () => {
	test('escapes %, / and . with their percent-encoded forms', () => {
		expect(escapeFirestoreKey('https://example.com/users/foo')).toBe('https:%2F%2Fexample%2Ecom%2Fusers%2Ffoo');
		expect(escapeFirestoreKey('50%off')).toBe('50%25off');
	});

	test('leaves other characters untouched', () => {
		expect(escapeFirestoreKey('foo bar+baz#qux?a=b')).toBe('foo bar+baz#qux?a=b');
	});
});

describe('escapeFirestoreKey / unescapeFirestoreKey round trip', () => {
	// `%` を最初にエスケープしているため、エスケープ後の文字列に残る `%` は
	// すべて escapeFirestoreKey 自身が挿入したものになる。そのため
	// unescapeFirestoreKey (decodeURIComponent) は常に正しく元の文字列へ復元できる。
	test.each([
		'https://example.com/users/foo',
		'https://example.com/users/foo.bar',
		'https://example.com/users/100%',
		'https://example.com/users/50%25off',
		'https://example.com/@caf%C3%A9', // 元から percent-encoding を含む ID
		'a%2Fb', // "/" ではなく文字列としての "%2F" を含む ID
		'a%zzb', // 不正な percent-encoding に見える文字列
		'100% off',
		'日本語のID',
		'',
	])('round-trips %j', (original) => {
		expect(unescapeFirestoreKey(escapeFirestoreKey(original))).toBe(original);
	});
});
