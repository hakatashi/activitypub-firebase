import { describe, expect, test } from 'vitest';
import { Counter, pickSafeHeaders, redactSensitiveBody, toIdArray } from '../../src/utils.js';

describe('Counter', () => {
	test('increments from 0 by default', () => {
		const counter = new Counter<string>();
		expect(counter.get('a')).toBe(0);
		expect(counter.increment('a')).toBe(1);
		expect(counter.get('a')).toBe(1);
	});

	test('increments by a custom amount', () => {
		const counter = new Counter<string>();
		counter.increment('a', 5);
		expect(counter.get('a')).toBe(5);
		expect(counter.increment('a', -2)).toBe(3);
		expect(counter.get('a')).toBe(3);
	});

	test('tracks keys independently', () => {
		const counter = new Counter<string>();
		counter.increment('a');
		counter.increment('b', 2);
		expect(counter.get('a')).toBe(1);
		expect(counter.get('b')).toBe(2);
		expect(counter.get('c')).toBe(0);
	});

	test('is iterable as [key, count] entries', () => {
		const counter = new Counter<string>();
		counter.increment('a');
		counter.increment('b', 2);
		expect(new Map(counter)).toEqual(
			new Map([
				['a', 1],
				['b', 2],
			]),
		);
		expect(Array.from(counter.entries())).toEqual([
			['a', 1],
			['b', 2],
		]);
	});
});

describe('pickSafeHeaders', () => {
	test('keeps only the allow-listed headers', () => {
		const headers = {
			accept: 'application/json',
			'content-type': 'application/json',
			authorization: 'Bearer secret-token',
			cookie: 'session=secret',
			signature: 'keyId="...",signature="..."',
		};
		expect(pickSafeHeaders(headers)).toEqual({
			accept: 'application/json',
			'content-type': 'application/json',
		});
	});

	test('omits allow-listed headers that are not present', () => {
		expect(pickSafeHeaders({ host: 'example.com' })).toEqual({ host: 'example.com' });
	});
});

describe('toIdArray', () => {
	test('returns an empty array for undefined/null', () => {
		expect(toIdArray(undefined)).toEqual([]);
		expect(toIdArray(null)).toEqual([]);
	});

	test('wraps a bare IRI string in an array', () => {
		expect(toIdArray('https://example.com/users/alice')).toEqual([
			'https://example.com/users/alice',
		]);
	});

	test('passes through an array of IRI strings', () => {
		expect(toIdArray(['https://example.com/users/alice', 'https://example.com/users/bob'])).toEqual(
			['https://example.com/users/alice', 'https://example.com/users/bob'],
		);
	});

	test('extracts id from an embedded object', () => {
		expect(toIdArray([{ id: 'https://example.com/users/alice', type: 'Person' }])).toEqual([
			'https://example.com/users/alice',
		]);
	});

	test('extracts href from a Link (boxed as an array per compactArrays: false)', () => {
		expect(toIdArray([{ type: 'Link', href: ['https://example.com/users/alice'] }])).toEqual([
			'https://example.com/users/alice',
		]);
	});

	test('drops entries without a usable id/href', () => {
		expect(toIdArray([{ type: 'Person' }])).toEqual([]);
	});

	test('handles a mix of strings, embedded objects and Links', () => {
		expect(
			toIdArray([
				'https://example.com/users/alice',
				{ id: 'https://example.com/users/bob', type: 'Person' },
				{ type: 'Link', href: ['https://example.com/users/carol'] },
			]),
		).toEqual([
			'https://example.com/users/alice',
			'https://example.com/users/bob',
			'https://example.com/users/carol',
		]);
	});
});

describe('redactSensitiveBody', () => {
	test('redacts sensitive fields at the top level', () => {
		expect(
			redactSensitiveBody({
				client_secret: 'super-secret',
				code: 'auth-code',
				username: 'hakatashi',
			}),
		).toEqual({
			client_secret: '[REDACTED]',
			code: '[REDACTED]',
			username: 'hakatashi',
		});
	});

	test('redacts sensitive fields inside nested objects', () => {
		expect(
			redactSensitiveBody({
				user: {
					password: 'hunter2',
					name: 'hakatashi',
				},
			}),
		).toEqual({
			user: {
				password: '[REDACTED]',
				name: 'hakatashi',
			},
		});
	});

	test('redacts sensitive fields inside arrays', () => {
		expect(redactSensitiveBody([{ accessToken: 'a' }, { refreshToken: 'b' }])).toEqual([
			{ accessToken: '[REDACTED]' },
			{ refreshToken: '[REDACTED]' },
		]);
	});

	test('leaves non-object values untouched', () => {
		expect(redactSensitiveBody('plain string')).toBe('plain string');
		expect(redactSensitiveBody(null)).toBe(null);
		expect(redactSensitiveBody(42)).toBe(42);
	});
});
