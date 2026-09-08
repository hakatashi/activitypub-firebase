import { describe, expect, test } from 'vitest';
import {
	Counter,
	firstOf,
	isAPActor,
	isAPFollow,
	isAPNote,
	isAPUndo,
	pickSafeHeaders,
	redactSensitiveBody,
	toIdArray,
	toError,
	toStringValue,
	toTypeArray,
	objectToTypeArray,
} from '../../src/utils.js';

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

	test('redacts _meta.privateKey on apex actor objects (onApexInbox/onApexOutbox log payloads)', () => {
		expect(
			redactSensitiveBody({
				recipient: {
					id: 'https://hakatashi.com/activitypub/u/hakatashi',
					_meta: { privateKey: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----' },
				},
			}),
		).toEqual({
			recipient: {
				id: 'https://hakatashi.com/activitypub/u/hakatashi',
				_meta: { privateKey: '[REDACTED]' },
			},
		});
	});

	test('leaves non-object values untouched', () => {
		expect(redactSensitiveBody('plain string')).toBe('plain string');
		expect(redactSensitiveBody(null)).toBe(null);
		expect(redactSensitiveBody(42)).toBe(42);
	});
});

describe('toTypeArray', () => {
	test('returns an empty array for undefined/null', () => {
		expect(toTypeArray(undefined)).toEqual([]);
		expect(toTypeArray(null)).toEqual([]);
	});

	test('wraps a single string in an array', () => {
		expect(toTypeArray('Note')).toEqual(['Note']);
	});

	test('passes through an array of strings', () => {
		expect(toTypeArray(['Note', 'https://schema.org/CreativeWork'])).toEqual([
			'Note',
			'https://schema.org/CreativeWork',
		]);
	});

	test('filters out non-string entries in an array', () => {
		expect(toTypeArray(['Note', 123, null, undefined, {}])).toEqual(['Note']);
	});

	test('returns an empty array for non-string scalars', () => {
		expect(toTypeArray(123)).toEqual([]);
		expect(toTypeArray({})).toEqual([]);
		expect(toTypeArray(true)).toEqual([]);
	});
});

describe('objectToTypeArray', () => {
	test('returns type as array for objects with string type', () => {
		expect(objectToTypeArray({ type: 'Note' })).toEqual(['Note']);
	});

	test('returns type as array for objects with array type', () => {
		expect(objectToTypeArray({ type: ['Note', 'Article'] })).toEqual(['Note', 'Article']);
	});

	test('returns an empty array for objects without type', () => {
		expect(objectToTypeArray({})).toEqual([]);
		expect(objectToTypeArray({ name: 'test' })).toEqual([]);
	});
});

describe('toStringValue', () => {
	test('returns undefined for undefined/null', () => {
		expect(toStringValue(undefined)).toBeUndefined();
		expect(toStringValue(null)).toBeUndefined();
	});

	test('returns the string itself for a string input', () => {
		expect(toStringValue('hello')).toBe('hello');
	});

	test('returns the first string from an array of strings', () => {
		expect(toStringValue(['first', 'second'])).toBe('first');
	});

	test('returns undefined if the first element of an array is not a string', () => {
		expect(toStringValue([123, 'second'])).toBeUndefined();
	});

	test('returns undefined for empty arrays', () => {
		expect(toStringValue([])).toBeUndefined();
	});

	test('returns undefined for non-string scalars', () => {
		expect(toStringValue(123)).toBeUndefined();
		expect(toStringValue({})).toBeUndefined();
		expect(toStringValue(true)).toBeUndefined();
	});
});

describe('firstOf', () => {
	test('returns undefined for undefined/null', () => {
		expect(firstOf(undefined)).toBeUndefined();
		expect(firstOf(null)).toBeUndefined();
	});

	test('returns the scalar value for non-array inputs', () => {
		expect(firstOf('scalar')).toBe('scalar');
		expect(firstOf(42)).toBe(42);
		expect(firstOf({ id: '1' })).toEqual({ id: '1' });
	});

	test('returns the first element from an array', () => {
		expect(firstOf(['a', 'b'])).toBe('a');
		expect(firstOf([42, 43])).toBe(42);
	});

	test('returns undefined for an empty array', () => {
		expect(firstOf([])).toBeUndefined();
	});
});

describe('isAPActor', () => {
	test('returns true for all actor types with string type', () => {
		for (const type of ['Person', 'Application', 'Group', 'Organization', 'Service']) {
			expect(isAPActor({ id: 'https://example.com/u/user', type })).toBe(true);
		}
	});

	test('returns true for actor types with array type (compactArrays: false)', () => {
		expect(isAPActor({ id: 'https://example.com/u/user', type: ['Person'] })).toBe(true);
	});

	test('returns false for non-actor types', () => {
		expect(isAPActor({ id: 'https://example.com/o/1', type: 'Note' })).toBe(false);
		expect(isAPActor({ id: 'https://example.com/o/1', type: ['Note'] })).toBe(false);
		expect(isAPActor({ id: 'https://example.com/a/1', type: 'Follow' })).toBe(false);
	});

	test('returns false for primitives, null, and undefined', () => {
		expect(isAPActor(null)).toBe(false);
		expect(isAPActor(undefined)).toBe(false);
		expect(isAPActor('Person')).toBe(false);
		expect(isAPActor(123)).toBe(false);
	});
});

describe('isAPNote', () => {
	test('returns true for Note with string type', () => {
		expect(isAPNote({ id: 'https://example.com/o/1', type: 'Note' })).toBe(true);
	});

	test('returns true for Note with array type (compactArrays: false)', () => {
		expect(isAPNote({ id: 'https://example.com/o/1', type: ['Note'] })).toBe(true);
	});

	test('returns false for non-Note types', () => {
		expect(isAPNote({ id: 'https://example.com/u/user', type: 'Person' })).toBe(false);
		expect(isAPNote({ id: 'https://example.com/a/1', type: 'Create' })).toBe(false);
	});

	test('returns false for primitives, null, and undefined', () => {
		expect(isAPNote(null)).toBe(false);
		expect(isAPNote(undefined)).toBe(false);
		expect(isAPNote('Note')).toBe(false);
	});
});

describe('isAPFollow', () => {
	test('returns true for Follow with string or array type', () => {
		expect(isAPFollow({ id: 'https://example.com/a/1', type: 'Follow' })).toBe(true);
		expect(isAPFollow({ id: 'https://example.com/a/1', type: ['Follow'] })).toBe(true);
	});

	test('returns false for other types or non-objects', () => {
		expect(isAPFollow({ id: 'https://example.com/a/1', type: 'Undo' })).toBe(false);
		expect(isAPFollow(null)).toBe(false);
	});
});

describe('isAPUndo', () => {
	test('returns true for Undo with string or array type', () => {
		expect(isAPUndo({ id: 'https://example.com/a/1', type: 'Undo' })).toBe(true);
		expect(isAPUndo({ id: 'https://example.com/a/1', type: ['Undo'] })).toBe(true);
	});

	test('returns false for other types or non-objects', () => {
		expect(isAPUndo({ id: 'https://example.com/a/1', type: 'Follow' })).toBe(false);
		expect(isAPUndo(null)).toBe(false);
	});
});

describe('toError', () => {
	test('returns the error instance if already an Error', () => {
		const err = new Error('original');
		expect(toError(err)).toBe(err);
	});

	test('wraps a string in an Error', () => {
		const err = toError('something failed');
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe('something failed');
	});

	test('wraps other primitives and objects in an Error', () => {
		expect(toError(123).message).toBe('123');
		expect(toError(null).message).toBe('null');
		expect(toError(undefined).message).toBe('undefined');
	});
});
