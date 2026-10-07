import type { APActor, APNote } from 'activitypub-types';
import type { mastodon } from 'masto';
import { describe, expect, test, vi } from 'vitest';
import {
	accountToCredentialAccount,
	actorObjectToAccount,
} from '../../src/mastodon/presenters/account.js';
import { noteObjectToStatus } from '../../src/mastodon/presenters/status.js';
import * as mastodonIdModule from '../../src/mastodonId.js';
import type { StatusViewerContext } from '../../src/mastodon/statusAttributes.js';
import {
	getMentionIris,
	isNoteVisibleTo,
	noteToMediaAttachments,
	noteToMentions,
	noteToViewerAttributes,
} from '../../src/mastodon/statusAttributes.js';
import { domain } from '../../src/firebase.js';
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

	test('returns username only as acct when actor domain matches local domain', async () => {
		const actor = {
			id: `https://${domain}/activitypub/u/hakatashi`,
			type: 'Person',
			preferredUsername: 'hakatashi',
		} as unknown as APActor;

		const account = await actorObjectToAccount(actor, userInfo);

		expect(account.acct).toBe('hakatashi');
	});

	test('uses explicitly specified id over userInfo.id', async () => {
		const actor = {
			id: 'https://example.com/activitypub/u/bob',
			type: 'Person',
			preferredUsername: 'bob',
		} as unknown as APActor;

		const account = await actorObjectToAccount(actor, userInfo, 'custom-id-999');

		expect(account.id).toBe('custom-id-999');
	});

	test('resolves id from getOrAssignMastodonId when neither id nor userInfo is provided', async () => {
		const actor = {
			id: 'https://remote.example/users/remoteuser',
			type: 'Person',
			preferredUsername: 'remoteuser',
		} as unknown as APActor;

		const spy = vi
			.spyOn(mastodonIdModule, 'getOrAssignMastodonId')
			.mockResolvedValueOnce('00109547043225600042');

		const account = await actorObjectToAccount(actor);

		expect(spy).toHaveBeenCalledWith('https://remote.example/users/remoteuser', undefined);
		expect(account.id).toBe('00109547043225600042');
		expect(account.username).toBe('remoteuser');
		expect(account.acct).toBe('remoteuser@remote.example');
	});
});

describe('accountToCredentialAccount', () => {
	test('converts account into CredentialAccount with source and default role', async () => {
		const actor = {
			id: `https://${domain}/activitypub/u/hakatashi`,
			type: 'Person',
			preferredUsername: 'hakatashi',
			summary: '<p>Bio content</p>',
		} as unknown as APActor;
		const account = await actorObjectToAccount(actor, userInfo);
		const credentialAccount = accountToCredentialAccount(account, userInfo);

		expect(credentialAccount).toMatchObject({
			...account,
			source: {
				privacy: 'public',
				sensitive: false,
				language: 'ja',
				note: 'Bio content',
				fields: [],
				follow_requests_count: 0,
			},
			role: {
				id: '-99',
				name: '',
				permissions: '0',
				color: '',
				highlighted: false,
			},
		});
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
			to: 'as:Public',
		} as unknown as APNote;

		const status = noteObjectToStatus(note, account, '00109547043225600000');

		expect(status).toMatchObject({
			id: '00109547043225600000',
			uri: 'https://example.com/activitypub/o/abc123',
			created_at: '2023-06-01T00:00:00.000Z',
			content: 'Hello, Fediverse!',
			visibility: 'public',
			account,
		});
	});

	test('takes the first element when content is an array', () => {
		const account = { username: 'hakatashi' } as unknown as CamelToSnake<mastodon.v1.Account>;
		const note = {
			id: 'https://example.com/activitypub/o/multi',
			published: '2023-06-01T00:00:00.000Z',
			content: ['first', 'second'],
		} as unknown as APNote;

		expect(noteObjectToStatus(note, account, '00109547043225600000').content).toBe('first');
	});

	test('includes converted media attachments', () => {
		const account = { username: 'hakatashi' } as unknown as CamelToSnake<mastodon.v1.Account>;
		const note = {
			id: 'https://remote.example/notes/with-media',
			published: '2023-06-01T00:00:00.000Z',
			attachment: [
				{
					type: 'Image',
					url: 'https://remote.example/image.png',
					name: 'alt',
				},
			],
		} as unknown as APNote;

		const status = noteObjectToStatus(note, account, '00109547043225600000');
		expect(status.media_attachments).toHaveLength(1);
		expect(status.media_attachments[0]?.url).toBe('https://remote.example/image.png');
		expect(status.media_attachments[0]?.description).toBe('alt');
	});
});

describe('noteObjectToStatus attribute derivation', () => {
	const account = {
		id: '1',
		username: 'hakatashi',
	} as unknown as CamelToSnake<mastodon.v1.Account>;
	const base = {
		id: 'https://example.com/activitypub/o/abc',
		type: 'Note',
		published: '2023-06-01T00:00:00.000Z',
		attributedTo: 'https://example.com/activitypub/u/hakatashi',
	};
	const make = (extra: Record<string, unknown>) => ({ ...base, ...extra }) as unknown as APNote;
	const followers = 'https://example.com/activitypub/u/hakatashi/followers';

	test.each([
		['public', { to: 'as:Public', cc: followers }],
		['public', { to: ['https://www.w3.org/ns/activitystreams#Public'] }],
		['unlisted', { to: followers, cc: 'as:Public' }],
		['private', { to: followers }],
		['private', { cc: [followers] }],
		['direct', { to: 'https://remote.example/users/a' }],
		['direct', {}],
	])('visibility is %s for %j', (visibility, extra) => {
		expect(noteObjectToStatus(make(extra), account, '1').visibility).toBe(visibility);
	});

	test('uses uri as the AP IRI and url as the human-facing url', () => {
		const status = noteObjectToStatus(make({ url: 'https://remote.example/@a/1' }), account, '1');
		expect(status.uri).toBe(base.id);
		expect(status.url).toBe('https://remote.example/@a/1');
		expect(noteObjectToStatus(make({}), account, '1').url).toBe(base.id);
	});

	test('resolves in_reply_to from context', () => {
		const status = noteObjectToStatus(make({ inReplyTo: 'x' }), account, '1', {
			inReplyTo: { id: '42', accountId: '7' },
		});
		expect(status).toMatchObject({ in_reply_to_id: '42', in_reply_to_account_id: '7' });
		expect(noteObjectToStatus(make({}), account, '1')).toMatchObject({
			in_reply_to_id: null,
			in_reply_to_account_id: null,
		});
	});

	test('derives sensitive, spoiler_text, language and edited_at', () => {
		const status = noteObjectToStatus(
			make({
				sensitive: true,
				summary: 'CW',
				contentMap: { en: 'hi' },
				updated: '2023-06-02T00:00:00.000Z',
			}),
			account,
			'1',
		);
		expect(status).toMatchObject({
			sensitive: true,
			spoiler_text: 'CW',
			language: 'en',
			edited_at: '2023-06-02T00:00:00.000Z',
		});
		const plain = noteObjectToStatus(make({ updated: base.published }), account, '1');
		expect(plain).toMatchObject({
			sensitive: false,
			spoiler_text: '',
			language: null,
			edited_at: null,
		});
	});

	test('derives counts from _meta first, then collection totalItems', () => {
		const note = make({
			replies: { totalItems: 3 },
			likes: { totalItems: 9 },
			shares: { totalItems: 8 },
		});
		expect(noteObjectToStatus(note, account, '1')).toMatchObject({
			replies_count: 3,
			favourites_count: 9,
			reblogs_count: 8,
		});
		expect(
			noteObjectToStatus(note, account, '1', { meta: { likesCount: 1, sharesCount: 2 } }),
		).toMatchObject({ favourites_count: 1, reblogs_count: 2 });
		expect(noteObjectToStatus(make({}), account, '1')).toMatchObject({
			replies_count: 0,
			favourites_count: 0,
			reblogs_count: 0,
		});
	});

	test('builds mentions, tags and emojis from tag', () => {
		const status = noteObjectToStatus(
			make({
				tag: [
					{ type: 'Mention', href: 'https://remote.example/users/a', name: '@a@remote.example' },
					{ type: 'Hashtag', href: 'https://example.com/tags/foo', name: '#foo' },
					{ type: 'Emoji', name: ':blob:', icon: { type: 'Image', url: 'https://e/blob.png' } },
				],
			}),
			account,
			'1',
		);
		expect(status.mentions).toEqual([
			{ id: '1', username: 'a', acct: 'a@remote.example', url: 'https://remote.example/users/a' },
		]);
		expect(status.tags).toEqual([{ name: 'foo', url: 'https://example.com/tags/foo' }]);
		expect(status.emojis).toEqual([
			{
				shortcode: 'blob',
				url: 'https://e/blob.png',
				static_url: 'https://e/blob.png',
				visible_in_picker: true,
			},
		]);
	});

	test('builds mentions with resolved IDs when mentionIds are provided in context', () => {
		const status = noteObjectToStatus(
			make({
				tag: [
					{ type: 'Mention', href: 'https://remote.example/users/a', name: '@a@remote.example' },
					{ type: 'Mention', href: 'https://remote.example/users/b', name: '@b@remote.example' },
				],
			}),
			account,
			'1',
			{
				mentionIds: new Map([
					['https://remote.example/users/a', '00109547043225600001'],
					['https://remote.example/users/b', '00109547043225600002'],
				]),
			},
		);
		expect(status.mentions).toEqual([
			{
				id: '00109547043225600001',
				username: 'a',
				acct: 'a@remote.example',
				url: 'https://remote.example/users/a',
			},
			{
				id: '00109547043225600002',
				username: 'b',
				acct: 'b@remote.example',
				url: 'https://remote.example/users/b',
			},
		]);
	});

	test('sets application only for local notes', () => {
		expect(noteObjectToStatus(make({}), account, '1').application).toBeNull();
		const local = make({ id: `https://${domain}/activitypub/o/1` });
		expect(noteObjectToStatus(local, account, '1').application).toMatchObject({
			name: 'activitypub-firebase',
		});
	});

	test('derives viewer interaction attributes from context.viewer', () => {
		const note = make({});
		const withoutViewer = noteObjectToStatus(note, account, '1');
		expect(withoutViewer.favourited).toBe(false);
		expect(withoutViewer.reblogged).toBe(false);
		expect(withoutViewer.bookmarked).toBe(false);
		expect(withoutViewer.pinned).toBe(false);

		const withViewer = noteObjectToStatus(note, account, '1', {
			viewer: {
				favourited: new Set([note.id as string]),
				reblogged: new Set([note.id as string]),
				bookmarked: new Set([note.id as string]),
				pinned: new Set([note.id as string]),
			},
		});
		expect(withViewer.favourited).toBe(true);
		expect(withViewer.reblogged).toBe(true);
		expect(withViewer.bookmarked).toBe(true);
		expect(withViewer.pinned).toBe(true);
	});
});

describe('isNoteVisibleTo', () => {
	const author = 'https://remote.example/u/alice';
	const viewer = 'https://example.com/activitypub/u/hakatashi';
	const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
	const note = (to: string[], cc: string[]) =>
		({ id: `${author}/n`, type: 'Note', attributedTo: author, to, cc }) as unknown as APNote;

	test('public / unlisted are visible to anyone', () => {
		expect(isNoteVisibleTo(note([PUBLIC], []), undefined)).toBe(true);
		expect(isNoteVisibleTo(note([], [PUBLIC]), undefined)).toBe(true);
	});

	test('followers-only is hidden from anonymous and non-followers', () => {
		const n = note([`${author}/followers`], []);
		expect(isNoteVisibleTo(n, undefined)).toBe(false);
		expect(isNoteVisibleTo(n, viewer, new Set())).toBe(false);
		expect(isNoteVisibleTo(n, viewer, new Set([author]))).toBe(true);
	});

	test('direct is visible only to author and recipients', () => {
		const n = note([viewer], []);
		expect(isNoteVisibleTo(n, undefined)).toBe(false);
		expect(isNoteVisibleTo(n, viewer)).toBe(true);
		expect(isNoteVisibleTo(n, 'https://example.com/other')).toBe(false);
		expect(isNoteVisibleTo(note([], []), author)).toBe(true);
	});
});

describe('getMentionIris', () => {
	test('extracts hrefs of Mention tags from note', () => {
		const note = {
			tag: [
				{
					type: 'Mention',
					href: 'https://remote.example/users/alice',
					name: '@alice@remote.example',
				},
				{ type: 'Hashtag', href: 'https://example.com/tags/foo', name: '#foo' },
				{ type: 'Mention', href: 'https://remote.example/users/bob', name: '@bob@remote.example' },
			],
		} as unknown as APNote;

		expect(getMentionIris(note)).toEqual([
			'https://remote.example/users/alice',
			'https://remote.example/users/bob',
		]);
	});

	test('returns empty array when note has no Mention tags', () => {
		const note = {
			tag: [{ type: 'Hashtag', href: 'https://example.com/tags/foo', name: '#foo' }],
		} as unknown as APNote;

		expect(getMentionIris(note)).toEqual([]);
	});
});

describe('noteToMentions', () => {
	test('resolves mention IDs using provided map', () => {
		const note = {
			tag: [
				{
					type: 'Mention',
					href: 'https://remote.example/users/alice',
					name: '@alice@remote.example',
				},
				{ type: 'Mention', href: 'https://remote.example/users/bob', name: '@bob' },
			],
		} as unknown as APNote;

		const mentions = noteToMentions(
			note,
			new Map([
				['https://remote.example/users/alice', '00109547043225600001'],
				['https://remote.example/users/bob', '00109547043225600002'],
			]),
		);

		expect(mentions).toEqual([
			{
				id: '00109547043225600001',
				username: 'alice',
				acct: 'alice@remote.example',
				url: 'https://remote.example/users/alice',
			},
			{
				id: '00109547043225600002',
				username: 'bob',
				acct: 'bob',
				url: 'https://remote.example/users/bob',
			},
		]);
	});

	test('falls back to "1" when mention ID is unmapped', () => {
		const note = {
			tag: [
				{
					type: 'Mention',
					href: 'https://remote.example/users/alice',
					name: '@alice@remote.example',
				},
			],
		} as unknown as APNote;

		const mentions = noteToMentions(note);
		expect(mentions).toEqual([
			{
				id: '1',
				username: 'alice',
				acct: 'alice@remote.example',
				url: 'https://remote.example/users/alice',
			},
		]);
	});
});

describe('noteToViewerAttributes', () => {
	const note = {
		id: 'https://example.com/activitypub/o/1',
	} as unknown as APNote;

	test('returns all false when viewer context is undefined', () => {
		expect(noteToViewerAttributes(note, undefined)).toEqual({
			favourited: false,
			reblogged: false,
			bookmarked: false,
			pinned: false,
		});
	});

	test('resolves boolean attributes from viewer context directly', () => {
		const viewer: StatusViewerContext = {
			favourited: true,
			reblogged: false,
			bookmarked: true,
			pinned: false,
		};
		expect(noteToViewerAttributes(note, viewer)).toEqual({
			favourited: true,
			reblogged: false,
			bookmarked: true,
			pinned: false,
		});
	});

	test('resolves attributes from Sets of IRIs in viewer context', () => {
		const viewer: StatusViewerContext = {
			favourited: new Set([note.id as string]),
			reblogged: new Set(),
			bookmarked: new Set([note.id as string]),
			pinned: new Set([note.id as string]),
		};
		expect(noteToViewerAttributes(note, viewer)).toEqual({
			favourited: true,
			reblogged: false,
			bookmarked: true,
			pinned: true,
		});
	});

	test('falls back to false when note id is not present in Sets', () => {
		const viewer: StatusViewerContext = {
			favourited: new Set(['https://example.com/other']),
			reblogged: new Set(['https://example.com/other']),
			bookmarked: new Set(['https://example.com/other']),
			pinned: new Set(['https://example.com/other']),
		};
		expect(noteToViewerAttributes(note, viewer)).toEqual({
			favourited: false,
			reblogged: false,
			bookmarked: false,
			pinned: false,
		});
	});
});

describe('noteToMediaAttachments', () => {
	const statusId = '00109547043225600000';

	test('converts attachment from actual Mastodon received Note format in dev Firestore', () => {
		const note = {
			id: 'https://mastodon-test.hakatashi.com/ap/users/117216175383849817/statuses/117398803316109031',
			type: 'Note',
			attachment: [
				{
					type: 'Document',
					'http://joinmastodon.org/ns#blurhash': ['U209dghVfQhVhVfjfQfjfQfQfQfQhVfjfQfj'],
					'http://joinmastodon.org/ns#focalPoint': [
						{
							'@list': [0.5, -0.5],
						},
					],
					height: [2],
					width: [2],
					mediaType: ['image/png'],
					name: ['test focal description'],
					url: [
						'https://mastodon-test.hakatashi.com/system/media_attachments/files/117/398/803/313/978/469/original/cda482ba8909cc2f.png',
					],
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments).toEqual([
			{
				id: '001095470432256000000',
				type: 'image',
				url: 'https://mastodon-test.hakatashi.com/system/media_attachments/files/117/398/803/313/978/469/original/cda482ba8909cc2f.png',
				preview_url:
					'https://mastodon-test.hakatashi.com/system/media_attachments/files/117/398/803/313/978/469/original/cda482ba8909cc2f.png',
				remote_url:
					'https://mastodon-test.hakatashi.com/system/media_attachments/files/117/398/803/313/978/469/original/cda482ba8909cc2f.png',
				preview_remote_url: null,
				text_url: null,
				meta: {
					original: {
						width: 2,
						height: 2,
						size: '2x2',
						aspect: 1,
					},
					small: {
						width: 2,
						height: 2,
						size: '2x2',
						aspect: 1,
					},
					focus: {
						x: 0.5,
						y: -0.5,
					},
				},
				description: 'test focal description',
				blurhash: 'U209dghVfQhVhVfjfQfjfQfQfQfQhVfjfQfj',
			},
		]);
	});

	test('converts Misskey / Pleroma style attachment with Link object and plain properties', () => {
		const note = {
			id: 'https://misskey.example/notes/abc1234',
			type: 'Note',
			attachment: [
				{
					type: 'Document',
					name: 'Misskey image description',
					blurhash: 'U209dghVfQhVhVfjfQfj',
					focalPoint: [0.25, -0.75],
					width: 1200,
					height: 800,
					url: [
						{
							type: 'Link',
							href: 'https://misskey.example/files/photo.jpg',
							mediaType: 'image/jpeg',
						},
					],
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments).toEqual([
			{
				id: '001095470432256000000',
				type: 'image',
				url: 'https://misskey.example/files/photo.jpg',
				preview_url: 'https://misskey.example/files/photo.jpg',
				remote_url: 'https://misskey.example/files/photo.jpg',
				preview_remote_url: null,
				text_url: null,
				meta: {
					original: {
						width: 1200,
						height: 800,
						size: '1200x800',
						aspect: 1.5,
					},
					small: {
						width: 1200,
						height: 800,
						size: '1200x800',
						aspect: 1.5,
					},
					focus: {
						x: 0.25,
						y: -0.75,
					},
				},
				description: 'Misskey image description',
				blurhash: 'U209dghVfQhVhVfjfQfj',
			},
		]);
	});

	test('converts video attachment and extracts preview from icon', () => {
		const note = {
			id: 'https://remote.example/notes/video1',
			type: 'Note',
			attachment: [
				{
					type: 'Video',
					mediaType: 'video/mp4',
					url: 'https://remote.example/videos/movie.mp4',
					icon: {
						type: 'Image',
						url: 'https://remote.example/videos/preview.jpg',
					},
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments).toEqual([
			{
				id: '001095470432256000000',
				type: 'video',
				url: 'https://remote.example/videos/movie.mp4',
				preview_url: 'https://remote.example/videos/preview.jpg',
				remote_url: 'https://remote.example/videos/movie.mp4',
				preview_remote_url: null,
				text_url: null,
				meta: null,
				description: null,
				blurhash: null,
			},
		]);
	});

	test('converts audio attachment with null preview_url', () => {
		const note = {
			id: 'https://remote.example/notes/audio1',
			type: 'Note',
			attachment: [
				{
					type: 'Audio',
					mediaType: 'audio/mpeg',
					url: 'https://remote.example/audio/song.mp3',
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments).toEqual([
			{
				id: '001095470432256000000',
				type: 'audio',
				url: 'https://remote.example/audio/song.mp3',
				preview_url: null,
				remote_url: 'https://remote.example/audio/song.mp3',
				preview_remote_url: null,
				text_url: null,
				meta: null,
				description: null,
				blurhash: null,
			},
		]);
	});

	test('converts unknown attachment type', () => {
		const note = {
			id: 'https://remote.example/notes/doc1',
			type: 'Note',
			attachment: [
				{
					type: 'Document',
					mediaType: 'application/pdf',
					url: 'https://remote.example/docs/paper.pdf',
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments).toEqual([
			{
				id: '001095470432256000000',
				type: 'unknown',
				url: 'https://remote.example/docs/paper.pdf',
				preview_url: null,
				remote_url: 'https://remote.example/docs/paper.pdf',
				preview_remote_url: null,
				text_url: null,
				meta: null,
				description: null,
				blurhash: null,
			},
		]);
	});

	test('sets remote_url to null for local note', () => {
		const note = {
			id: `https://${domain}/activitypub/o/local-note`,
			type: 'Note',
			attachment: [
				{
					type: 'Image',
					url: `https://${domain}/media/image.png`,
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments[0]?.remote_url).toBeNull();
		expect(attachments[0]?.url).toBe(`https://${domain}/media/image.png`);
	});

	test('assigns sequential IDs to multiple attachments', () => {
		const note = {
			id: 'https://remote.example/notes/multi',
			type: 'Note',
			attachment: [
				{
					type: 'Image',
					url: 'https://remote.example/1.png',
				},
				{
					type: 'Image',
					url: 'https://remote.example/2.png',
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments.map((a) => a.id)).toEqual([
			'001095470432256000000',
			'001095470432256000001',
		]);
	});

	test('skips unsupported or invalid attachments', () => {
		const note = {
			id: 'https://remote.example/notes/invalid',
			type: 'Note',
			attachment: [
				// Unsupported AP type
				{
					type: 'Article',
					url: 'https://remote.example/article',
				},
				// Missing URL
				{
					type: 'Image',
				},
				// Invalid URL scheme
				{
					type: 'Image',
					url: 'javascript:alert(1)',
				},
				// Non-object
				'https://remote.example/string-attachment',
				// Valid
				{
					type: 'Image',
					url: 'https://remote.example/valid.png',
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId);

		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.url).toBe('https://remote.example/valid.png');
		expect(attachments[0]?.id).toBe('001095470432256000000');
	});

	test('preserves local media attachment ID from storage URL and uses icon as preview_url (ADR-0092)', () => {
		const note = {
			id: `https://${domain}/activitypub/o/local-note`,
			type: 'Note',
			attachment: [
				{
					type: 'Document',
					mediaType: 'image/jpeg',
					url: 'https://storage.googleapis.com/my-bucket/media_attachments/files/01924294028402948201/original.jpeg',
					icon: {
						type: 'Image',
						url: 'https://storage.googleapis.com/my-bucket/media_attachments/files/01924294028402948201/small.jpeg',
					},
				},
			],
		} as unknown as APNote;

		const attachments = noteToMediaAttachments(note, statusId, { isLocal: true });

		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.id).toBe('01924294028402948201');
		expect(attachments[0]?.preview_url).toBe(
			'https://storage.googleapis.com/my-bucket/media_attachments/files/01924294028402948201/small.jpeg',
		);
		expect(attachments[0]?.remote_url).toBeNull();
	});
});
