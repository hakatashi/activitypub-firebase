import type {APActor, APNote} from 'activitypub-types';
import {describe, expect, test} from 'vitest';
import {actorObjectToAccount, noteObjectToStatus} from '../../src/mastodon/api.js';
import type {UserInfo} from '../../src/schema.js';

const userInfo: UserInfo = {
	id: '123',
	locked: false,
	bot: false,
	created_at: '2023-01-01T00:00:00.000Z',
	followers_count: 3,
	following_count: 5,
	statuses_count: 7,
	last_status_at: '2023-06-01',
	emojis: [],
	fields: [],
	roles: [],
	uid: 'firebase-uid',
};

describe('actorObjectToAccount', () => {
	test('converts an ActivityPub actor into a Mastodon account', async () => {
		const actor = {
			id: 'https://example.com/activitypub/u/hakatashi',
			type: 'Person',
			preferredUsername: 'hakatashi',
			name: 'Koki Takahashi',
			summary: 'こんにちは',
			discoverable: true,
			icon: {type: 'Image', url: 'https://example.com/icon.png'},
			image: {type: 'Image', url: 'https://example.com/header.png'},
		} as unknown as APActor;

		const account = await actorObjectToAccount(actor, userInfo);

		expect(account).toMatchObject({
			...userInfo,
			username: 'hakatashi',
			acct: 'hakatashi@example.com',
			display_name: 'Koki Takahashi',
			note: 'こんにちは',
			discoverable: true,
			avatar: 'https://example.com/icon.png',
			avatar_static: 'https://example.com/icon.png',
			header: 'https://example.com/header.png',
			header_static: 'https://example.com/header.png',
		});
	});

	test('falls back to the id tail as username when preferredUsername is missing', async () => {
		const actor = {
			id: 'https://example.com/activitypub/u/anonymous',
			type: 'Person',
		} as unknown as APActor;

		const account = await actorObjectToAccount(actor, userInfo);

		expect(account.acct).toBe('anonymous@example.com');
	});
});

describe('noteObjectToStatus', () => {
	test('converts an ActivityPub note into a Mastodon status', async () => {
		const actor = {
			id: 'https://example.com/activitypub/u/hakatashi',
			type: 'Person',
			preferredUsername: 'hakatashi',
		} as unknown as APActor;
		const account = await actorObjectToAccount(actor, userInfo);

		const note = {
			id: 'https://example.com/activitypub/o/abc123',
			type: 'Note',
			published: '2023-06-01T00:00:00.000Z',
			content: 'Hello, Fediverse!',
		} as unknown as APNote;

		const status = noteObjectToStatus(note, account);

		expect(status).toMatchObject({
			id: 'abc123',
			created_at: '2023-06-01T00:00:00.000Z',
			content: 'Hello, Fediverse!',
			visibility: 'public',
			account,
		});
	});

	test('takes the first element when content is an array', () => {
		const account = {username: 'hakatashi'} as any;
		const note = {
			id: 'https://example.com/activitypub/o/multi',
			published: '2023-06-01T00:00:00.000Z',
			content: ['first', 'second'],
		} as unknown as APNote;

		expect(noteObjectToStatus(note, account).content).toBe('first');
	});
});
