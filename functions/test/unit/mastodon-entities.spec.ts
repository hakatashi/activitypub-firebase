import type { APActor, APNote } from 'activitypub-types';
import type { mastodon } from 'masto';
import { describe, expect, test } from 'vitest';
import { domain } from '../../src/firebase.js';
import {
	actorObjectToAccount,
	getStatusVisibility,
	noteObjectToStatus,
} from '../../src/mastodon/api.js';
import type { UserInfo } from '../../src/schema.js';
import type { CamelToSnake } from '../../src/utils.js';

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
			icon: { type: 'Image', url: 'https://example.com/icon.png' },
			image: { type: 'Image', url: 'https://example.com/header.png' },
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

	// mastodon.v1.Account の avatar/header/note/discoverable は non-optional なので、
	// icon/image/summary/discoverable を持たない actor でも空文字列/false で埋める必要がある
	test('fills icon/image/summary/discoverable fields with empty defaults when absent', async () => {
		const actor = {
			id: 'https://example.com/activitypub/u/noicon',
			type: 'Person',
		} as unknown as APActor;

		const account = await actorObjectToAccount(actor, userInfo);

		expect(account).toMatchObject({
			avatar: '',
			avatar_static: '',
			header: '',
			header_static: '',
			note: '',
			discoverable: false,
		});
	});
});

describe('getStatusVisibility', () => {
	test('returns public when as:Public is in to', () => {
		const note = {
			to: ['as:Public'],
			cc: ['https://example.com/followers'],
		} as unknown as APNote;
		expect(getStatusVisibility(note)).toBe('public');
	});

	test('returns public when full W3C Public URI or bare Public is in to', () => {
		const note1 = {
			to: 'https://www.w3.org/ns/activitystreams#Public',
		} as unknown as APNote;
		expect(getStatusVisibility(note1)).toBe('public');

		const note2 = {
			to: 'Public',
		} as unknown as APNote;
		expect(getStatusVisibility(note2)).toBe('public');
	});

	test('returns unlisted when as:Public is in cc but not in to', () => {
		const note = {
			to: ['https://example.com/users/alice/followers'],
			cc: ['as:Public'],
		} as unknown as APNote;
		expect(getStatusVisibility(note)).toBe('unlisted');
	});

	test('returns private when followers collection is in to or cc', () => {
		const note1 = {
			to: ['https://example.com/users/alice/followers'],
		} as unknown as APNote;
		expect(getStatusVisibility(note1)).toBe('private');

		const note2 = {
			to: ['https://example.com/users/bob'],
			cc: ['https://example.com/my-followers-custom-uri'],
		} as unknown as APNote;
		expect(getStatusVisibility(note2, 'https://example.com/my-followers-custom-uri')).toBe(
			'private',
		);
	});

	test('returns direct when addressed to specific actors only', () => {
		const note = {
			to: ['https://example.com/users/alice'],
			cc: ['https://example.com/users/bob'],
		} as unknown as APNote;
		expect(getStatusVisibility(note)).toBe('direct');
	});

	test('returns direct when to and cc are empty', () => {
		const note = {} as unknown as APNote;
		expect(getStatusVisibility(note)).toBe('direct');
	});
});

describe('noteObjectToStatus', () => {
	const defaultAccount = {
		username: 'hakatashi',
	} as unknown as CamelToSnake<mastodon.v1.Account>;

	test('converts an ActivityPub note into a Mastodon status', async () => {
		const actor = {
			id: `https://${domain}/activitypub/u/hakatashi`,
			type: 'Person',
			preferredUsername: 'hakatashi',
		} as unknown as APActor;
		const account = await actorObjectToAccount(actor, userInfo);

		const note = {
			id: `https://${domain}/activitypub/o/abc123`,
			type: 'Note',
			published: '2023-06-01T00:00:00.000Z',
			to: 'as:Public',
			content: 'Hello, Fediverse!',
		} as unknown as APNote;

		const status = noteObjectToStatus(note, account, '00109547043225600000');

		expect(status).toMatchObject({
			id: '00109547043225600000',
			uri: `https://${domain}/activitypub/o/abc123`,
			url: `https://${domain}/@hakatashi@${domain}/00109547043225600000`,
			created_at: '2023-06-01T00:00:00.000Z',
			edited_at: null,
			content: 'Hello, Fediverse!',
			visibility: 'public',
			in_reply_to_id: null,
			in_reply_to_account_id: null,
			sensitive: false,
			spoiler_text: '',
			language: 'ja',
			replies_count: 0,
			reblogs_count: 0,
			favourites_count: 0,
			media_attachments: [],
			mentions: [],
			tags: [],
			application: {
				name: 'activitypub-firebase',
				website: `https://${domain}`,
			},
			account,
		});
	});

	test('takes the first element when content is an array', () => {
		const note = {
			id: `https://${domain}/activitypub/o/multi`,
			published: '2023-06-01T00:00:00.000Z',
			content: ['first', 'second'],
		} as unknown as APNote;

		expect(noteObjectToStatus(note, defaultAccount, '00109547043225600000').content).toBe('first');
	});

	test('resolves in_reply_to_id and in_reply_to_account_id from repliesMap', () => {
		const note = {
			id: `https://${domain}/activitypub/o/reply`,
			published: '2023-06-01T00:00:00.000Z',
			inReplyTo: 'https://remote.example/o/parent-note',
		} as unknown as APNote;

		const status = noteObjectToStatus(note, defaultAccount, {
			id: '00109547043225600000',
			repliesMap: new Map([
				[
					'https://remote.example/o/parent-note',
					{ statusId: '00109547043200000000', accountId: '456' },
				],
			]),
		});

		expect(status.in_reply_to_id).toBe('00109547043200000000');
		expect(status.in_reply_to_account_id).toBe('456');
	});

	test('leaves in_reply_to_id and in_reply_to_account_id as null when parent note is uncached', () => {
		const note = {
			id: `https://${domain}/activitypub/o/reply`,
			published: '2023-06-01T00:00:00.000Z',
			inReplyTo: 'https://remote.example/o/unknown-note',
		} as unknown as APNote;

		const status = noteObjectToStatus(note, defaultAccount, '00109547043225600000');

		expect(status.in_reply_to_id).toBeNull();
		expect(status.in_reply_to_account_id).toBeNull();
	});

	test('derives sensitive and spoiler_text correctly', () => {
		const note1 = {
			id: `https://${domain}/activitypub/o/sensitive`,
			published: '2023-06-01T00:00:00.000Z',
			sensitive: true,
			summary: 'Content Warning!',
		} as unknown as APNote;

		const status1 = noteObjectToStatus(note1, defaultAccount, '00109547043225600000');
		expect(status1.sensitive).toBe(true);
		expect(status1.spoiler_text).toBe('Content Warning!');

		const note2 = {
			id: `https://${domain}/activitypub/o/summary-map`,
			published: '2023-06-01T00:00:00.000Z',
			summaryMap: { ja: 'ネタバレ注意' },
		} as unknown as APNote;

		const status2 = noteObjectToStatus(note2, defaultAccount, '00109547043225600000');
		expect(status2.sensitive).toBe(false);
		expect(status2.spoiler_text).toBe('ネタバレ注意');
	});

	test('derives language from contentMap, summaryMap, or falls back by locality', () => {
		const noteWithContentMap = {
			id: 'https://remote.example/o/note1',
			published: '2023-06-01T00:00:00.000Z',
			contentMap: { en: 'Hello' },
		} as unknown as APNote;
		expect(
			noteObjectToStatus(noteWithContentMap, defaultAccount, '00109547043225600000').language,
		).toBe('en');

		const noteWithSummaryMap = {
			id: 'https://remote.example/o/note2',
			published: '2023-06-01T00:00:00.000Z',
			summaryMap: { fr: 'Attention' },
		} as unknown as APNote;
		expect(
			noteObjectToStatus(noteWithSummaryMap, defaultAccount, '00109547043225600000').language,
		).toBe('fr');

		const localNote = {
			id: `https://${domain}/activitypub/o/local`,
			published: '2023-06-01T00:00:00.000Z',
		} as unknown as APNote;
		expect(noteObjectToStatus(localNote, defaultAccount, '00109547043225600000').language).toBe(
			'ja',
		);

		const remoteNote = {
			id: 'https://remote.example/o/remote-no-lang',
			published: '2023-06-01T00:00:00.000Z',
		} as unknown as APNote;
		expect(
			noteObjectToStatus(remoteNote, defaultAccount, '00109547043225600000').language,
		).toBeNull();
	});

	test('derives edited_at from updated datetime', () => {
		const note = {
			id: `https://${domain}/activitypub/o/edited`,
			published: '2023-06-01T00:00:00.000Z',
			updated: '2023-06-02T15:30:00.000Z',
		} as unknown as APNote;

		const status = noteObjectToStatus(note, defaultAccount, '00109547043225600000');
		expect(status.edited_at).toBe('2023-06-02T15:30:00.000Z');
	});

	test('derives replies_count, reblogs_count, and favourites_count from collection totalItems and _meta', () => {
		const noteFromRemote = {
			id: 'https://remote.example/o/remote1',
			published: '2023-06-01T00:00:00.000Z',
			replies: { type: 'Collection', totalItems: 3 },
			shares: { type: 'OrderedCollection', totalItems: 5 },
			likes: [{ type: 'OrderedCollection', totalItems: 8 }],
		} as unknown as APNote;

		const statusFromRemote = noteObjectToStatus(
			noteFromRemote,
			defaultAccount,
			'00109547043225600000',
		);
		expect(statusFromRemote.replies_count).toBe(3);
		expect(statusFromRemote.reblogs_count).toBe(5);
		expect(statusFromRemote.favourites_count).toBe(8);

		const noteWithMeta = {
			id: `https://${domain}/activitypub/o/local-meta`,
			published: '2023-06-01T00:00:00.000Z',
			_meta: {
				likesCount: 14,
				sharesCount: 9,
			},
		} as unknown as APNote;

		const statusWithMeta = noteObjectToStatus(noteWithMeta, defaultAccount, '00109547043225600000');
		expect(statusWithMeta.favourites_count).toBe(14);
		expect(statusWithMeta.reblogs_count).toBe(9);
	});

	test('extracts hashtags from tag property with deduplication and # removal', () => {
		const note = {
			id: `https://${domain}/activitypub/o/tags`,
			published: '2023-06-01T00:00:00.000Z',
			tag: [
				{
					type: 'Hashtag',
					name: '#ActivityPub',
					href: 'https://example.com/tags/ActivityPub',
				},
				{
					type: 'Hashtag',
					name: 'fediverse',
				},
				{
					type: 'Hashtag',
					name: '#activitypub', // duplicate case-insensitive
				},
			],
		} as unknown as APNote;

		const status = noteObjectToStatus(note, defaultAccount, '00109547043225600000');
		expect(status.tags).toEqual([
			{
				name: 'ActivityPub',
				url: 'https://example.com/tags/ActivityPub',
			},
			{
				name: 'fediverse',
				url: `https://${domain}/tags/fediverse`,
			},
		]);
	});

	test('extracts mentions from tag property and maps account IDs', () => {
		const note = {
			id: `https://${domain}/activitypub/o/mentions`,
			published: '2023-06-01T00:00:00.000Z',
			tag: [
				{
					type: 'Mention',
					name: '@alice@mastodon.social',
					href: 'https://mastodon.social/users/alice',
				},
				{
					type: 'Mention',
					name: '@bob',
					href: `https://${domain}/activitypub/u/bob`,
				},
			],
		} as unknown as APNote;

		const status = noteObjectToStatus(note, defaultAccount, {
			id: '00109547043225600000',
			accountMap: new Map([
				['https://mastodon.social/users/alice', '999'],
				[`https://${domain}/activitypub/u/bob`, '888'],
			]),
		});

		expect(status.mentions).toEqual([
			{
				id: '999',
				username: 'alice',
				acct: 'alice@mastodon.social',
				url: 'https://mastodon.social/users/alice',
			},
			{
				id: '888',
				username: 'bob',
				acct: 'bob',
				url: `https://${domain}/activitypub/u/bob`,
			},
		]);
	});

	test('sets application to null on remote posts and retains it on local posts', () => {
		const localNote = {
			id: `https://${domain}/activitypub/o/local-app`,
			published: '2023-06-01T00:00:00.000Z',
		} as unknown as APNote;
		const localStatus = noteObjectToStatus(localNote, defaultAccount, '00109547043225600000');
		expect(localStatus.application).toEqual({
			name: 'activitypub-firebase',
			website: `https://${domain}`,
		});

		const remoteNote = {
			id: 'https://remote.social/activitypub/o/remote-app',
			published: '2023-06-01T00:00:00.000Z',
		} as unknown as APNote;
		const remoteStatus = noteObjectToStatus(remoteNote, defaultAccount, '00109547043225600000');
		expect(remoteStatus.application).toBeNull();
	});

	test('uses remote note url if present, otherwise generates local status url', () => {
		const remoteNoteWithUrl = {
			id: 'https://remote.social/users/alice/statuses/1234',
			url: 'https://remote.social/@alice/1234',
			published: '2023-06-01T00:00:00.000Z',
		} as unknown as APNote;
		const remoteStatus = noteObjectToStatus(
			remoteNoteWithUrl,
			defaultAccount,
			'00109547043225600000',
		);
		expect(remoteStatus.uri).toBe('https://remote.social/users/alice/statuses/1234');
		expect(remoteStatus.url).toBe('https://remote.social/@alice/1234');

		const remoteNoteWithLinkObject = {
			id: 'https://remote.social/users/bob/statuses/5678',
			url: { href: 'https://remote.social/@bob/5678', type: 'Link' },
			published: '2023-06-01T00:00:00.000Z',
		} as unknown as APNote;
		const remoteLinkStatus = noteObjectToStatus(
			remoteNoteWithLinkObject,
			defaultAccount,
			'00109547043225600000',
		);
		expect(remoteLinkStatus.url).toBe('https://remote.social/@bob/5678');
	});
});
