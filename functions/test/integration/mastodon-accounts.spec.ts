import firebase from 'firebase-admin';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/activitypub.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { AccessTokens, Streams, UserInfos } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const UID_ME = 'uid-hakatashi';
const UID_ALICE = 'uid-alice';

describe('Mastodon Accounts API (Issue #62)', () => {
	let me: Awaited<ReturnType<typeof apex.createActor>>;
	let alice: Awaited<ReturnType<typeof apex.createActor>>;

	const addToken = async (token: string, scope: string, uid = UID_ME) => {
		const farFuture = firebase.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
		await AccessTokens.add({
			accessToken: token,
			accessTokenExpiresAt: farFuture,
			refreshTokenExpiresAt: farFuture,
			scope,
			client: { id: '1', grants: [] },
			user: { userId: uid },
		} as never);
	};

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);

		me = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(me);
		await UserInfos.doc(escapeFirestoreKey(me.id)).set({
			id: '1',
			uid: UID_ME,
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

		alice = await apex.createActor('alice', 'alice', '', '', 'Person');
		await apex.store.saveObject(alice);
		await UserInfos.doc(escapeFirestoreKey(alice.id)).set({
			id: '2',
			uid: UID_ALICE,
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
	});

	afterEach(() => {
		vi.restoreAllMocks();
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
			});
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
					actors: { [escapeFirestoreKey(me.id)]: true },
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
