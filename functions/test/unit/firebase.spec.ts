import { describe, expect, test } from 'vitest';
import {
	FUNCTION_REGION,
	domain,
	escapeFirestoreKey,
	mastodonDomain,
	projectId,
	taskQueueName,
	toFirestoreKey,
	unescapeFirestoreKey,
} from '../../src/firebase.js';
import { metaIndexPath } from '../../src/meta.js';
import { UserInfos } from '../../src/schema.js';

describe('escapeFirestoreKey', () => {
	test('escapes %, / and . with their percent-encoded forms', () => {
		expect(escapeFirestoreKey('https://example.com/users/foo')).toBe(
			'https:%2F%2Fexample%2Ecom%2Fusers%2Ffoo',
		);
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

describe('toFirestoreKey', () => {
	test('returns the key typed as FirestoreKey without modifying it', () => {
		const rawKey = 'https:%2F%2Fexample%2Ecom%2Fusers%2Ffoo';
		const firestoreKey = toFirestoreKey(rawKey);
		expect(firestoreKey).toBe(rawKey);
		expect(unescapeFirestoreKey(firestoreKey)).toBe('https://example.com/users/foo');
	});
});

describe('FirestoreKey type constraints', () => {
	test('doc() and metaIndexPath() reject unbranded raw strings at compile time', () => {
		const rawString = 'https://example.com/users/foo';

		if (false as boolean) {
			// @ts-expect-error: raw string cannot be passed to doc() without escapeFirestoreKey()
			UserInfos.doc(rawString);
			// @ts-expect-error: raw string cannot be passed to metaIndexPath() without escapeFirestoreKey()
			metaIndexPath('objects', rawString);
			// @ts-expect-error: raw string cannot be passed to unescapeFirestoreKey() without FirestoreKey
			unescapeFirestoreKey(rawString);
		}

		// Valid branded key passes
		const key = escapeFirestoreKey(rawString);
		expect(UserInfos.doc(key)).toBeDefined();
		expect(metaIndexPath('objects', key)).toBeDefined();
		expect(unescapeFirestoreKey(key)).toBe(rawString);
	});
});

describe('domain and mastodonDomain configuration (ADR-0077, ADR-0148)', () => {
	test('resolves to dev domain when projectId is not activitypub-firebase', () => {
		// 対応表にない projectId は dev の設定になる (ADR-0148)。
		// テストでワーカーごとに GCLOUD_PROJECT (例: activitypub-firebase-dev-w1) を変えても
		// ドメイン判定が変わらない前提をここで固定する (ADR-0077)。
		expect(domain).toBe('activitypub-dev.hakatashi.com');
		expect(mastodonDomain).toBe('mastodon-dev.hakatashi.com');
		expect(projectId).not.toBe('activitypub-firebase');
		expect(projectId).toMatch(/^activitypub-firebase-dev-w/);
	});
});

describe('FUNCTION_REGION and taskQueueName (ADR-0119)', () => {
	test('FUNCTION_REGION is asia-northeast1', () => {
		expect(FUNCTION_REGION).toBe('asia-northeast1');
	});

	test('taskQueueName builds resource name with asia-northeast1', () => {
		expect(taskQueueName('deliveryTask')).toBe('locations/asia-northeast1/functions/deliveryTask');
		expect(taskQueueName('pingTask')).toBe('locations/asia-northeast1/functions/pingTask');
	});
});
