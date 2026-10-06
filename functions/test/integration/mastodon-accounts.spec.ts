import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { Streams } from '../../src/schema.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const UID_ALICE = 'uid-alice';

describe('Mastodon Accounts API (Issue #62)', () => {
	let me: LocalActor;

	const addToken = (token: string, scope: string, uid = UID_ME) =>
		addAccessToken(token, scope, uid);

	beforeEach(async () => {
		await resetFirestore();
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);

		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
		await createLocalActor('alice', { uid: UID_ALICE, id: '2' });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('GET /api/v1/accounts/verify_credentials', () => {
		test('returns 401 when unauthorized', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/verify_credentials');
			expect(res.status).toBe(401);
		});

		test('returns full CredentialAccount with source and role when authorized', async () => {
			await addToken('test-token', 'read:accounts');

			const res = await request(mastodon)
				.get('/api/v1/accounts/verify_credentials')
				.set('Authorization', 'Bearer test-token');

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: '1',
				username: 'hakatashi',
				acct: 'hakatashi',
				display_name: 'hakatashi',
				source: {
					privacy: 'public',
					sensitive: false,
					language: 'ja',
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

	describe('GET /api/v1/accounts/:id', () => {
		test('returns 404 when account does not exist', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/999');
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ error: 'Record not found' });
		});

		test('returns account when exists', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/2');
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: '2',
				username: 'alice',
				acct: 'alice',
				display_name: 'alice',
			});
		});

		test('returns account when resolved via Mastodon ID', async () => {
			const bob = await apex.createActor('bob', 'bob', '', '', 'Person');
			bob.id = 'https://remote.example/users/bob';
			await apex.store.saveObject(bob);
			const bobMastodonId = await getOrAssignMastodonId(bob.id, undefined);

			const res = await request(mastodon).get(`/api/v1/accounts/${bobMastodonId}`);
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: bobMastodonId,
				username: 'bob',
				acct: 'bob@remote.example',
				url: 'https://remote.example/users/bob',
			});
		});
	});

	describe('GET /api/v1/accounts/:id/statuses', () => {
		test('returns 404 when account does not exist', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/999/statuses');
			expect(res.status).toBe(404);
		});

		test('returns statuses of remote account resolved via Mastodon ID', async () => {
			const bob = await apex.createActor('bob', 'bob', '', '', 'Person');
			bob.id = 'https://remote.example/users/bob';
			await apex.store.saveObject(bob);
			const bobMastodonId = await getOrAssignMastodonId(bob.id, undefined);
			// inbox で受けたリモートの Note は attributedTo が配列で保存される (→ ADR-0072)
			await apex.store.saveObject({
				id: 'https://remote.example/users/bob/statuses/1',
				type: 'Note',
				attributedTo: [bob.id],
				content: 'hello from bob',
				published: '2026-01-01T00:00:00.000Z',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				cc: [],
			} as never);

			const res = await request(mastodon).get(`/api/v1/accounts/${bobMastodonId}/statuses`);
			expect(res.status).toBe(200);
			expect(res.body.map((status: { uri: string }) => status.uri)).toEqual([
				'https://remote.example/users/bob/statuses/1',
			]);
			expect(res.body[0].account.id).toBe(bobMastodonId);
		});
	});

	describe('GET /api/v1/accounts/lookup', () => {
		test('returns 404 for nonexistent local account', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/lookup').query({ acct: 'nobody' });
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ error: 'Record not found' });
		});

		test('returns 404 for remote domain account without 500 error', async () => {
			const res = await request(mastodon)
				.get('/api/v1/accounts/lookup')
				.query({ acct: 'user@remote.example' });
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ error: 'Record not found' });
		});

		test('returns cached remote account whose preferredUsername is stored as array', async () => {
			// inbox で受けた actor は apex が preferredUsername を配列で保存する (→ ADR-0073)
			await apex.store.saveObject({
				id: 'https://remote.example/users/carol',
				type: 'Person',
				preferredUsername: ['carol'],
				inbox: ['https://remote.example/users/carol/inbox'],
				outbox: ['https://remote.example/users/carol/outbox'],
			} as never);
			// 同名でもドメインが違う actor は一致させない
			await apex.store.saveObject({
				id: 'https://other.example/users/carol',
				type: 'Person',
				preferredUsername: ['carol'],
				inbox: ['https://other.example/users/carol/inbox'],
				outbox: ['https://other.example/users/carol/outbox'],
			} as never);
			const carolMastodonId = await getOrAssignMastodonId(
				'https://remote.example/users/carol',
				undefined,
			);

			const res = await request(mastodon)
				.get('/api/v1/accounts/lookup')
				.query({ acct: 'carol@remote.example' });
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: carolMastodonId,
				username: 'carol',
				acct: 'carol@remote.example',
			});
		});

		test('returns account for existing local account', async () => {
			const res = await request(mastodon)
				.get('/api/v1/accounts/lookup')
				.query({ acct: 'hakatashi' });
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: '1',
				username: 'hakatashi',
			});
		});
	});

	describe('GET /api/v1/accounts/relationships', () => {
		test('returns 401 when unauthorized', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/relationships').query({ id: '2' });
			expect(res.status).toBe(401);
		});

		test('returns relationships for accounts', async () => {
			await addToken('test-token', 'read:follows');

			const res = await request(mastodon)
				.get('/api/v1/accounts/relationships')
				.set('Authorization', 'Bearer test-token')
				.query({ id: ['2'] });

			expect(res.status).toBe(200);
			expect(res.body).toEqual([
				{
					id: '2',
					following: false,
					showing_reblogs: false,
					notifying: false,
					languages: [],
					followed_by: false,
					blocking: false,
					blocked_by: false,
					muting: false,
					muting_notifications: false,
					muting_expires_at: null,
					requested: false,
					requested_by: false,
					domain_blocking: false,
					endorsed: false,
					note: '',
				},
			]);
		});
	});

	describe('PATCH /api/v1/accounts/update_credentials', () => {
		test('returns 401 when unauthorized', async () => {
			const res = await request(mastodon).patch('/api/v1/accounts/update_credentials');
			expect(res.status).toBe(401);
		});

		test('returns 403 when scope is insufficient', async () => {
			await addToken('read-only-token', 'read');

			const res = await request(mastodon)
				.patch('/api/v1/accounts/update_credentials')
				.set('Authorization', 'Bearer read-only-token')
				.send({ display_name: 'New Name' });

			expect(res.status).toBe(403);
		});

		test('updates credentials and publishes update', async () => {
			await addToken('write-token', 'write:accounts');

			const res = await request(mastodon)
				.patch('/api/v1/accounts/update_credentials')
				.set('Authorization', 'Bearer write-token')
				.send({
					display_name: 'Updated Name',
					note: 'My updated bio',
					locked: true,
					fields_attributes: [{ name: 'Blog', value: 'https://blog.hakatashi.com' }],
				});

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: '1',
				display_name: 'Updated Name',
				locked: true,
				source: {
					note: 'My updated bio',
					fields: [{ name: 'Blog', value: 'https://blog.hakatashi.com' }],
				},
			});
			expect(apex.publishUpdate).toHaveBeenCalled();
		});
	});

	describe('POST /api/v1/accounts/:id/follow and /unfollow', () => {
		test('returns 422 when trying to follow self', async () => {
			await addToken('follow-token', 'write:follows');

			const res = await request(mastodon)
				.post('/api/v1/accounts/1/follow')
				.set('Authorization', 'Bearer follow-token');

			expect(res.status).toBe(422);
			expect(res.body).toEqual({ error: 'You cannot follow yourself' });
		});

		test('follows account and returns relationship', async () => {
			await addToken('follow-token', 'write:follows');

			const res = await request(mastodon)
				.post('/api/v1/accounts/2/follow')
				.set('Authorization', 'Bearer follow-token');

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: '2',
				following: true,
				requested: false,
			});

			// streams に Follow activity が作成されていること
			const streams = await Streams.where('type', '==', 'Follow')
				.where(escapeFirestoreKey(me.id) ? 'type' : 'type', '==', 'Follow')
				.get();
			expect(streams.empty).toBe(false);
		});

		test('unfollows account and returns relationship', async () => {
			await addToken('follow-token', 'write:follows');

			// まずフォロー
			await request(mastodon)
				.post('/api/v1/accounts/2/follow')
				.set('Authorization', 'Bearer follow-token');

			// 次にアンフォロー
			const res = await request(mastodon)
				.post('/api/v1/accounts/2/unfollow')
				.set('Authorization', 'Bearer follow-token');

			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				id: '2',
				following: false,
			});

			// Streams に Undo activity があること
			const undoStreams = await Streams.where('type', '==', 'Undo').get();
			expect(undoStreams.empty).toBe(false);
		});
	});

	describe('GET /api/v1/accounts/:id/following', () => {
		test('returns 404 when user id does not exist', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/unknown-id/following');
			expect(res.status).toBe(404);
			expect(res.body.error).toBe('Record not found');
		});

		test('returns empty array when account follows no one', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/1/following');
			expect(res.status).toBe(200);
			expect(res.body).toEqual([]);
		});

		test('returns remote account with real Snowflake ID in following list (Issue #154, ADR-0069)', async () => {
			const bob = await apex.createActor('bob', 'bob', '', '', 'Person');
			bob.id = 'https://remote.example/users/bob';
			await apex.store.saveObject(bob);
			const bobMastodonId = await getOrAssignMastodonId(bob.id, undefined);

			const follow = await apex.buildActivity('Follow', me.id, bob.id, {
				object: bob.id,
			});
			follow._meta = {
				...follow._meta,
				actors: [me.id],
				index: {
					collections: {},
					actors: { [escapeFirestoreKey(me.id)]: true },
					objects: {},
				},
			};
			await apex.store.saveActivity(follow);

			const accept = await apex.buildActivity('Accept', bob.id, me.id, {
				object: follow.id,
			});
			const meInbox = `${me.id}/inbox`;
			accept._meta = {
				...accept._meta,
				collection: [meInbox],
				index: {
					collections: { [escapeFirestoreKey(meInbox)]: true },
					actors: {},
					objects: {},
				},
			};
			await apex.store.saveActivity(accept);

			const res = await request(mastodon).get('/api/v1/accounts/1/following');
			expect(res.status).toBe(200);
			expect(res.body.length).toBe(1);
			expect(res.body[0].id).toBe(bobMastodonId);
			expect(res.body[0].username).toBe('bob');
			expect(res.body[0].acct).toBe('bob@remote.example');
			expect(res.body[0].id).not.toBe('1');
		});
	});
});
