import type { APObject } from '../../src/apex/index.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import { mastodonDomain } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const REMOTE = 'https://remote.example/users/alice';

// ハッシュタグのタイムライン・Tag・検索 (→ ADR-0103)。
describe('Mastodon hashtag API (Issue #228)', () => {
	let me: LocalActor;
	let n = 0;

	const saveNote = async ({
		attributedTo = REMOTE,
		tags,
		visibility = 'public',
		extra = {},
	}: {
		attributedTo?: string;
		tags: string[];
		visibility?: 'public' | 'unlisted' | 'private';
		extra?: Record<string, unknown>;
	}) => {
		n++;
		const followers = `${attributedTo}/followers`;
		const addressing = {
			public: { to: [PUBLIC], cc: [followers] },
			unlisted: { to: [followers], cc: [PUBLIC] },
			private: { to: [followers], cc: [] },
		}[visibility];
		const id = `${attributedTo}/statuses/${n}`;
		await apex.store.saveObject({
			id,
			type: 'Note',
			attributedTo,
			content: `note ${n}`,
			published: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
			// 受信した Note と同じく、apex が JSON-LD を正規化した形 (`as:Hashtag`、配列) で入れておく。
			tag: tags.map((name) => ({
				type: 'as:Hashtag',
				name: [`#${name}`],
				href: [`https://remote.example/tags/${name}`],
			})),
			...addressing,
			...extra,
		} as unknown as APObject);
		return id;
	};

	beforeEach(async () => {
		await resetFirestore();
		n = 0;
		me = await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
		await apex.store.saveObject({
			id: REMOTE,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE}/inbox`,
			outbox: `${REMOTE}/outbox`,
		} as unknown as APObject);
		await addAccessToken('token', 'read');
	});

	afterEach(async () => {
		await resetFirestore();
	});

	const tagTimeline = (hashtag: string, query: Record<string, string | string[]> = {}) =>
		request(mastodon)
			.get(`/api/v1/timelines/tag/${encodeURIComponent(hashtag)}`)
			.query(query);

	const uris = (body: { uri: string }[]) => body.map((status) => status.uri);

	describe('GET /api/v1/timelines/tag/:hashtag', () => {
		test('returns public notes with the tag, newest first, ignoring case', async () => {
			const first = await saveNote({ tags: ['Foo'] });
			await saveNote({ tags: ['bar'] });
			const second = await saveNote({ tags: ['FOO', 'bar'] });
			const res = await tagTimeline('foo');
			expect(res.status).toBe(200);
			expect(uris(res.body)).toEqual([second, first]);

			const upper = await tagTimeline('ＦＯＯ');
			expect(uris(upper.body)).toEqual([second, first]);
		});

		test('handles non-ASCII tags', async () => {
			const id = await saveNote({ tags: ['日本語'] });
			const res = await tagTimeline('日本語');
			expect(uris(res.body)).toEqual([id]);
		});

		test('excludes non-public notes', async () => {
			const publicId = await saveNote({ tags: ['foo'] });
			await saveNote({ tags: ['foo'], visibility: 'unlisted' });
			await saveNote({ tags: ['foo'], visibility: 'private' });
			const res = await tagTimeline('foo');
			expect(uris(res.body)).toEqual([publicId]);
		});

		test('paginates with max_id / min_id and sets the Link header', async () => {
			const ids = [];
			for (let i = 0; i < 5; i++) {
				ids.push(await saveNote({ tags: ['foo'] }));
				await saveNote({ tags: ['other'] });
			}
			const page1 = await tagTimeline('foo', { limit: '2' });
			expect(uris(page1.body)).toEqual([ids[4], ids[3]]);
			expect(page1.headers.link).toContain('max_id=');

			const page2 = await tagTimeline('foo', { limit: '2', max_id: page1.body[1].id });
			expect(uris(page2.body)).toEqual([ids[2], ids[1]]);

			const newer = await tagTimeline('foo', { limit: '2', min_id: page2.body[1].id });
			expect(uris(newer.body)).toEqual([ids[3], ids[2]]);
		});

		test('supports any[] / all[] / none[]', async () => {
			const foo = await saveNote({ tags: ['foo'] });
			const fooBar = await saveNote({ tags: ['foo', 'bar'] });
			const baz = await saveNote({ tags: ['baz'] });
			const fooQux = await saveNote({ tags: ['foo', 'qux'] });

			expect(uris((await tagTimeline('foo', { 'any[]': ['baz'] })).body)).toEqual([
				fooQux,
				baz,
				fooBar,
				foo,
			]);
			expect(uris((await tagTimeline('foo', { 'all[]': ['Bar'] })).body)).toEqual([fooBar]);
			expect(uris((await tagTimeline('foo', { 'none[]': ['bar', 'qux'] })).body)).toEqual([foo]);
		});

		test('supports local / remote / only_media', async () => {
			const remote = await saveNote({ tags: ['foo'] });
			const local = await saveNote({ attributedTo: me.id, tags: ['foo'] });
			const media = await saveNote({
				tags: ['foo'],
				extra: {
					attachment: [
						{ type: 'Document', mediaType: 'image/png', url: 'https://remote.example/a.png' },
					],
				},
			});
			expect(uris((await tagTimeline('foo', { local: 'true' })).body)).toEqual([local]);
			expect(uris((await tagTimeline('foo', { remote: 'true' })).body)).toEqual([media, remote]);
			expect(uris((await tagTimeline('foo', { only_media: 'true' })).body)).toEqual([media]);
		});

		test('returns an empty list for unknown or invalid tags', async () => {
			await saveNote({ tags: ['foo'] });
			expect((await tagTimeline('unknown')).body).toEqual([]);
			expect((await tagTimeline('!!')).body).toEqual([]);
		});
	});

	describe('GET /api/v1/tags/:name', () => {
		test('returns a Tag even when there are no notes', async () => {
			const res = await request(mastodon).get('/api/v1/tags/FooBar');
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				name: 'FooBar',
				url: `https://${mastodonDomain}/tags/FooBar`,
				history: [],
				following: false,
			});
		});

		test('returns 404 for invalid names', async () => {
			const res = await request(mastodon).get(`/api/v1/tags/${encodeURIComponent('!!')}`);
			expect(res.status).toBe(404);
		});

		test('does not support following tags', async () => {
			const res = await request(mastodon)
				.post('/api/v1/tags/foo/follow')
				.set('Authorization', 'Bearer token');
			expect(res.status).toBe(404);
		});
	});

	describe('GET /api/v2/search hashtags', () => {
		const searchRequest = (query: Record<string, string>) =>
			request(mastodon).get('/api/v2/search').query(query);

		test('returns an exact match when a public note has the tag', async () => {
			await saveNote({ tags: ['Foo'] });
			const res = await searchRequest({ q: '#FOO' });
			expect(res.status).toBe(200);
			expect(res.body.hashtags).toEqual([
				{
					name: 'FOO',
					url: `https://${mastodonDomain}/tags/FOO`,
					history: [],
					following: false,
				},
			]);
			const byType = await searchRequest({ q: 'foo', type: 'hashtags' });
			expect(byType.body.hashtags.map((tag: { name: string }) => tag.name)).toEqual(['foo']);
			expect(byType.body.accounts).toEqual([]);
		});

		test('returns no hashtags without public notes or for other types', async () => {
			await saveNote({ tags: ['secret'], visibility: 'private' });
			await saveNote({ tags: ['foo'] });
			expect((await searchRequest({ q: '#secret' })).body.hashtags).toEqual([]);
			expect((await searchRequest({ q: '#fo' })).body.hashtags).toEqual([]);
			expect((await searchRequest({ q: '#foo', type: 'accounts' })).body.hashtags).toEqual([]);
			expect((await searchRequest({ q: 'foo@remote.example' })).body.hashtags).toEqual([]);
		});

		test('still returns accounts alongside hashtags', async () => {
			await saveNote({ tags: ['hakatashi'] });
			const res = await searchRequest({ q: 'hakatashi' });
			expect(res.body.accounts.map((account: { acct: string }) => account.acct)).toEqual([
				'hakatashi',
			]);
			expect(res.body.hashtags.map((tag: { name: string }) => tag.name)).toEqual(['hakatashi']);
		});
	});

	describe('GET /tags/:name', () => {
		test('redirects to the tag page on Elk', async () => {
			const res = await request(mastodon).get(`/tags/${encodeURIComponent('日本語')}`);
			expect(res.status).toBe(302);
			expect(res.headers.location).toBe(
				`https://elk.zone/${mastodonDomain}/tags/${encodeURIComponent('日本語')}`,
			);
		});
	});
});
