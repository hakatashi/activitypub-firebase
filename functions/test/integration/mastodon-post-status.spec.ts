import type { APObject } from 'activitypub-types';
import firebase from 'firebase-admin';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/activitypub.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { reserveIdempotencyKey } from '../../src/idempotency.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { AccessTokens, IdempotencyKeys, Objects, Streams, UserInfos } from '../../src/schema.js';
import * as webfinger from '../../src/webfinger.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const PUBLIC = 'as:Public';
const REMOTE = 'https://remote.example/u/alice';
const UID = 'uid-hakatashi';

const countNotes = async () =>
	(await Objects.where('type', '==', 'Note').get()).docs.length +
	(await Objects.where('type', 'array-contains', 'Note').get()).docs.length;

describe('POST /api/v1/statuses (Issue #60)', () => {
	let me: Awaited<ReturnType<typeof apex.createActor>>;

	const addToken = async (token: string, scope: string) => {
		const farFuture = firebase.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
		await AccessTokens.add({
			accessToken: token,
			accessTokenExpiresAt: farFuture,
			refreshTokenExpiresAt: farFuture,
			scope,
			client: { id: '1', grants: [] },
			user: { userId: UID },
		} as never);
	};

	const post = (body: Record<string, unknown>, token = 'write-token') =>
		request(mastodon).post('/api/v1/statuses').set('Authorization', `Bearer ${token}`).send(body);

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
		// 配送 (Cloud Tasks への enqueue) はテストの対象外。
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);

		me = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(me);
		await UserInfos.doc(escapeFirestoreKey(me.id)).set({
			id: '1',
			uid: UID,
			locked: false,
			bot: false,
			created_at: '2026-01-01T00:00:00.000Z',
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: '',
			emojis: [],
			fields: [],
			roles: [],
		});
		await apex.store.saveObject({
			id: REMOTE,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE}/inbox`,
			outbox: `${REMOTE}/outbox`,
		} as unknown as APObject);
		await addToken('write-token', 'read write follow');
		await addToken('statuses-token', 'write:statuses');
		await addToken('read-token', 'read');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	test('creates a public note, delivers Create via outbox and returns the Status', async () => {
		const response = await post({ status: 'hello <world>\n\nsecond', language: 'ja' });
		expect(response.status).toBe(200);

		const status = response.body;
		expect(status.id).toMatch(/^\d{20}$/);
		expect(status.visibility).toBe('public');
		expect(status.content).toBe('<p>hello &lt;world&gt;</p><p>second</p>');
		expect(status.language).toBe('ja');
		expect(status.account.username).toBe('hakatashi');
		expect(status.uri).toMatch(/\/activitypub\/o\//);

		const ids = await getMastodonIds([{ iri: status.uri, published: undefined }]);
		expect(ids.get(status.uri)).toBe(status.id);

		const note = await apex.store.getObject(status.uri);
		expect(note?.attributedTo).toBe(me.id);
		expect(note?.to).toEqual([PUBLIC]);
		expect(note?.cc).toEqual([`${me.id}/followers`]);

		const creates = await Streams.where('type', 'array-contains', 'Create').get();
		const createsScalar = await Streams.where('type', '==', 'Create').get();
		const activities = [...creates.docs, ...createsScalar.docs].map((doc) => doc.data());
		expect(activities).toHaveLength(1);
		expect(JSON.stringify(activities[0]?.object)).toContain(status.uri);
		expect(JSON.stringify(activities[0]?._meta?.collection)).toContain(`${me.id}/outbox`);
		expect(JSON.stringify(activities[0]?.object)).toContain('"contentMap":{"ja":');
		expect(JSON.stringify(activities[0]?.object)).not.toContain('_meta');
	});

	test('converts blank lines with whitespace into paragraphs', async () => {
		const response = await post({ status: 'first\n  \nsecond' });
		expect(response.status).toBe(200);
		expect(response.body.content).toBe('<p>first</p><p>second</p>');
	});

	test.each([
		['public', [PUBLIC], [`/followers`]],
		['unlisted', [`/followers`], [PUBLIC]],
		['private', [`/followers`], []],
		['direct', [], []],
	] as const)('maps visibility %s to to/cc', async (visibility, to, cc) => {
		const response = await post({ status: 'hi', visibility });
		expect(response.status).toBe(200);
		expect(response.body.visibility).toBe(visibility);
		const note = await apex.store.getObject(response.body.uri);
		const expand = (iris: readonly string[]) =>
			iris.map((iri) => (iri.startsWith('/') ? `${me.id}${iri}` : iri));
		expect(note?.to).toEqual(expand(to));
		expect(note?.cc).toEqual(expand(cc));
	});

	test('maps spoiler_text / sensitive', async () => {
		const response = await post({ status: 'body', spoiler_text: 'cw' });
		expect(response.status).toBe(200);
		expect(response.body.spoiler_text).toBe('cw');
		expect(response.body.sensitive).toBe(true);

		// 配送される Create にも JSON-LD の正規化を経て残っていること。
		const [create] = (await Streams.get()).docs.map((doc) => doc.data());
		const embedded = JSON.stringify(create?.object);
		expect(embedded).toContain('"sensitive":[true]');
		expect(embedded).toContain('"summary":["cw"]');

		const plain = await post({ status: 'body', sensitive: 'false' });
		expect(plain.body.sensitive).toBe(false);
		const sensitive = await post({ status: 'body', sensitive: true });
		expect(sensitive.body.sensitive).toBe(true);
	});

	test('replies to a stored note and addresses its author', async () => {
		const parentIri = `${REMOTE}/notes/1`;
		await apex.store.saveObject({
			id: parentIri,
			type: 'Note',
			attributedTo: REMOTE,
			content: 'parent',
			published: '2026-01-01T00:00:00.000Z',
			to: [PUBLIC],
			cc: [`${REMOTE}/followers`],
		} as unknown as APObject);
		const parentId = (await getMastodonIds([{ iri: parentIri, published: undefined }])).get(
			parentIri,
		);

		vi.spyOn(webfinger, 'resolveMentions').mockResolvedValue(
			new Map([
				[
					'@alice@remote.example',
					{ actorIri: REMOTE, url: REMOTE, username: 'alice', domain: 'remote.example' },
				],
			]),
		);
		const response = await post({
			status: '@alice@remote.example reply',
			in_reply_to_id: parentId,
		});
		expect(response.status).toBe(200);
		expect(response.body.in_reply_to_id).toBe(parentId);

		const note = await apex.store.getObject(response.body.uri);
		expect(note?.inReplyTo).toEqual([parentIri]);
		expect(note?.cc).toEqual([`${me.id}/followers`, REMOTE]);
	});

	test('parses mentions, URLs, and hashtags, saving tags and mentions', async () => {
		vi.spyOn(webfinger, 'resolveMentions').mockResolvedValue(
			new Map([
				[
					'@alice@remote.example',
					{ actorIri: REMOTE, url: REMOTE, username: 'alice', domain: 'remote.example' },
				],
			]),
		);
		const response = await post({
			status: 'Hello @alice@remote.example #fediverse see https://example.com',
		});
		expect(response.status).toBe(200);
		expect(response.body.content).toContain('class="u-url mention"');
		expect(response.body.content).toContain('class="mention hashtag"');
		expect(response.body.content).toContain('href="https://example.com"');
		expect(response.body.tags).toEqual([
			{ name: 'fediverse', url: 'https://mastodon-dev.hakatashi.com/tags/fediverse' },
		]);
		expect(response.body.mentions).toHaveLength(1);
		expect(response.body.mentions[0]?.username).toBe('alice');
		expect(response.body.mentions[0]?.acct).toBe('alice@remote.example');

		const note = await apex.store.getObject(response.body.uri);
		expect(note?.tag).toEqual([
			{
				type: 'Mention',
				href: REMOTE,
				name: '@alice@remote.example',
			},
			{
				type: 'Hashtag',
				href: 'https://mastodon-dev.hakatashi.com/tags/fediverse',
				name: '#fediverse',
			},
		]);
		expect(note?.cc).toEqual([`${me.id}/followers`, REMOTE]);
	});

	test('delivers direct post to mentioned user', async () => {
		vi.spyOn(webfinger, 'resolveMentions').mockResolvedValue(
			new Map([
				[
					'@alice@remote.example',
					{ actorIri: REMOTE, url: REMOTE, username: 'alice', domain: 'remote.example' },
				],
			]),
		);
		const response = await post({
			status: '@alice@remote.example secret message',
			visibility: 'direct',
		});
		expect(response.status).toBe(200);
		expect(response.body.visibility).toBe('direct');

		const note = await apex.store.getObject(response.body.uri);
		expect(note?.to).toEqual([REMOTE]);
		expect(note?.cc).toEqual([]);
	});

	test('returns 404 when in_reply_to_id is unknown', async () => {
		const response = await post({ status: 'reply', in_reply_to_id: '00000000000000000001' });
		expect(response.status).toBe(404);
		expect(await countNotes()).toBe(0);
	});

	test.each([
		['media_ids', ['1']],
		['poll', { options: ['a', 'b'], expires_in: 3600 }],
		['scheduled_at', '2099-01-01T00:00:00.000Z'],
	])('rejects %s with 422 instead of ignoring it', async (field, value) => {
		const response = await post({ status: 'hi', [field]: value });
		expect(response.status).toBe(422);
		expect(await countNotes()).toBe(0);
	});

	test('accepts empty media_ids and null poll as sent by Elk', async () => {
		const response = await post({ status: 'hi', media_ids: [], poll: null, in_reply_to_id: null });
		expect(response.status).toBe(200);
	});

	test('rejects blank or too long status with 422', async () => {
		expect((await post({ status: '  ' })).status).toBe(422);
		expect((await post({ status: 'x'.repeat(1000) })).status).toBe(422);
		expect((await post({ status: 'hi', visibility: 'everyone' })).status).toBe(422);
		expect(await countNotes()).toBe(0);
	});

	test('requires write:statuses scope', async () => {
		expect((await post({ status: 'hi' }, 'read-token')).status).toBe(403);
		expect((await post({ status: 'hi' }, 'statuses-token')).status).toBe(200);
	});

	describe('Idempotency-Key', () => {
		test('posting twice with the same key creates only one note', async () => {
			const first = await post({ status: 'once' }).set('Idempotency-Key', 'key-1');
			const second = await post({ status: 'once' }).set('Idempotency-Key', 'key-1');
			expect(first.status).toBe(200);
			expect(second.status).toBe(200);
			expect(second.body.id).toBe(first.body.id);
			expect(second.body.uri).toBe(first.body.uri);
			expect(await countNotes()).toBe(1);
		});

		test('different keys create different notes', async () => {
			await post({ status: 'a' }).set('Idempotency-Key', 'key-1');
			await post({ status: 'a' }).set('Idempotency-Key', 'key-2');
			expect(await countNotes()).toBe(2);
		});

		test('an expired key does not block a new note', async () => {
			const first = await post({ status: 'a' }).set('Idempotency-Key', 'key-1');
			const docs = await IdempotencyKeys.get();
			expect(docs.size).toBe(1);
			await docs.docs[0]?.ref.update({
				expiresAt: firebase.firestore.Timestamp.fromMillis(Date.now() - 1000),
			});
			const second = await post({ status: 'a' }).set('Idempotency-Key', 'key-1');
			expect(second.body.id).not.toBe(first.body.id);
			expect(await countNotes()).toBe(2);
		});

		test('returns 503 while the original request has not saved the note yet', async () => {
			const reservation = await reserveIdempotencyKey({
				actorId: me.id,
				key: 'key-1',
				noteIri: `https://${new URL(me.id).host}/activitypub/o/pending`,
			});
			expect(reservation.type).toBe('reserved');
			const response = await post({ status: 'a' }).set('Idempotency-Key', 'key-1');
			expect(response.status).toBe(503);
			expect(await countNotes()).toBe(0);
		});

		test('releases the key when the note could not be created', async () => {
			const saveObject = vi
				.spyOn(apex.store, 'saveObject')
				.mockRejectedValueOnce(new Error('boom'));
			const response = await post({ status: 'a' }).set('Idempotency-Key', 'key-1');
			saveObject.mockRestore();
			expect(response.status).toBe(500);
			expect((await IdempotencyKeys.get()).size).toBe(0);
		});
	});
});
