import { describe, expect, test } from 'vitest';
import { domain, mastodonDomain } from '../../src/firebase.js';
import {
	LOCAL_ADMIN_EMAIL,
	LOCAL_DISPLAY_NAME,
	LOCAL_ICON_URL,
	LOCAL_SUMMARY,
	LOCAL_USERNAME,
	localAccountUrl,
	localActorId,
	localActorIri,
	localFollowersId,
	localFollowersIri,
	localFollowingId,
	localFollowingIri,
	localInboxIri,
	localOutboxIri,
} from '../../src/localActor.js';
import { routes } from '../../src/routes.js';

describe('localActor constants', () => {
	test('defines expected user attributes', () => {
		expect(LOCAL_USERNAME).toBe('hakatashi');
		expect(LOCAL_DISPLAY_NAME).toBe('hakatashi');
		expect(LOCAL_SUMMARY).toBe('博多市です。');
		expect(LOCAL_ICON_URL).toBe(
			'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
		);
		expect(LOCAL_ADMIN_EMAIL).toBe('hakatasiloving@gmail.com');
	});

	test('defines localAccountUrl correctly', () => {
		expect(localAccountUrl).toBe(`https://elk.zone/${mastodonDomain}/@${LOCAL_USERNAME}@${domain}`);
	});
});

describe('localActor IRI builders', () => {
	test('localActorIri builds IRI matching routes.actor', () => {
		expect(localActorIri()).toBe(`https://${domain}/activitypub/u/hakatashi`);
		expect(localActorIri()).toBe(`https://${domain}${routes.actor.replace(':actor', 'hakatashi')}`);
		expect(localActorIri('alice')).toBe(`https://${domain}/activitypub/u/alice`);
		expect(localActorIri('bob', 'example.org')).toBe('https://example.org/activitypub/u/bob');
	});

	test('localFollowersIri builds IRI matching routes.followers', () => {
		expect(localFollowersIri()).toBe(`https://${domain}/activitypub/u/hakatashi/followers`);
		expect(localFollowersIri()).toBe(
			`https://${domain}${routes.followers.replace(':actor', 'hakatashi')}`,
		);
		expect(localFollowersIri('alice')).toBe(`https://${domain}/activitypub/u/alice/followers`);
		expect(localFollowersIri('bob', 'example.org')).toBe(
			'https://example.org/activitypub/u/bob/followers',
		);
	});

	test('localFollowingIri builds IRI matching routes.following', () => {
		expect(localFollowingIri()).toBe(`https://${domain}/activitypub/u/hakatashi/following`);
		expect(localFollowingIri()).toBe(
			`https://${domain}${routes.following.replace(':actor', 'hakatashi')}`,
		);
		expect(localFollowingIri('alice')).toBe(`https://${domain}/activitypub/u/alice/following`);
		expect(localFollowingIri('bob', 'example.org')).toBe(
			'https://example.org/activitypub/u/bob/following',
		);
	});

	test('localInboxIri builds IRI matching routes.inbox', () => {
		expect(localInboxIri()).toBe(`https://${domain}/activitypub/u/hakatashi/inbox`);
		expect(localInboxIri()).toBe(`https://${domain}${routes.inbox.replace(':actor', 'hakatashi')}`);
		expect(localInboxIri('alice')).toBe(`https://${domain}/activitypub/u/alice/inbox`);
		expect(localInboxIri('bob', 'example.org')).toBe('https://example.org/activitypub/u/bob/inbox');
	});

	test('localOutboxIri builds IRI matching routes.outbox', () => {
		expect(localOutboxIri()).toBe(`https://${domain}/activitypub/u/hakatashi/outbox`);
		expect(localOutboxIri()).toBe(
			`https://${domain}${routes.outbox.replace(':actor', 'hakatashi')}`,
		);
		expect(localOutboxIri('alice')).toBe(`https://${domain}/activitypub/u/alice/outbox`);
		expect(localOutboxIri('bob', 'example.org')).toBe(
			'https://example.org/activitypub/u/bob/outbox',
		);
	});

	test('static IRI constants match default IRI builders', () => {
		expect(localActorId).toBe(localActorIri());
		expect(localFollowersId).toBe(localFollowersIri());
		expect(localFollowingId).toBe(localFollowingIri());
	});
});
