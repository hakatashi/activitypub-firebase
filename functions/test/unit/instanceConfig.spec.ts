import { describe, expect, test } from 'vitest';
import {
	BOTS_PROJECT_ID,
	DEV_PROJECT_ID,
	PRODUCTION_PROJECT_ID,
	resolveInstanceConfig,
} from '../../src/instanceConfig.js';

describe('resolveInstanceConfig (ADR-0148)', () => {
	test('production keeps the existing domains and primary actor', () => {
		const config = resolveInstanceConfig(PRODUCTION_PROJECT_ID);
		expect(config.domain).toBe('hakatashi.com');
		expect(config.mastodonDomain).toBe('mastodon.hakatashi.com');
		expect(config.primaryActor.username).toBe('hakatashi');
		expect(config.primaryActor.type).toBe('Person');
		expect(config.primaryActor.loginEmail).toBe('hakatasiloving@gmail.com');
		expect(config.bots.enabled).toBe(false);
	});

	test('dev keeps the existing domains and enables bots for testing', () => {
		const config = resolveInstanceConfig(DEV_PROJECT_ID);
		expect(config.domain).toBe('activitypub-dev.hakatashi.com');
		expect(config.mastodonDomain).toBe('mastodon-dev.hakatashi.com');
		expect(config.primaryActor.username).toBe('hakatashi');
		expect(config.bots.enabled).toBe(true);
		expect(config.bots.defaultFollowAllowlist).toEqual([
			'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi',
		]);
	});

	test('bots serves ActivityPub and Mastodon API on one domain without login', () => {
		const config = resolveInstanceConfig(BOTS_PROJECT_ID);
		expect(config.domain).toBe('bots.activitypub.hakatashi.com');
		expect(config.mastodonDomain).toBe('bots.activitypub.hakatashi.com');
		expect(config.primaryActor.type).toBe('Application');
		expect(config.primaryActor.loginEmail).toBeNull();
		expect(config.bots.enabled).toBe(true);
		expect(config.bots.defaultFollowAllowlist).toEqual([
			'https://hakatashi.com/activitypub/u/hakatashi',
			'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi',
		]);
	});

	test.each([undefined, 'activitypub-firebase-dev-w1', 'unknown-project'])(
		'falls back to dev for %j',
		(projectId) => {
			expect(resolveInstanceConfig(projectId)).toBe(resolveInstanceConfig(DEV_PROJECT_ID));
		},
	);
});
