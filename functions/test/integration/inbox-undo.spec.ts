import type { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, apex, app } from '../../src/activitypub.js';
import { onStreamCreated, onStreamWritten } from '../../src/denormalizations.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { getFollowers } from '../../src/mastodon/api.js';
import { Streams, UserInfos } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';
const OTHER_REMOTE_ACTOR_ID = 'https://remote.example/u/bob';

const makeWrittenEvent = (data: unknown) =>
	data as unknown as Parameters<typeof onStreamWritten.run>[0];

const makeCreatedEvent = (data: unknown) =>
	data as unknown as Parameters<typeof onStreamCreated.run>[0];

const triggerStreamEvents = async (docId: string) => {
	const ref = Streams.doc(escapeFirestoreKey(docId));
	const snapshot = await ref.get();
	if (snapshot.exists) {
		await onStreamCreated.run(makeCreatedEvent({ data: snapshot as QueryDocumentSnapshot }));
		await onStreamWritten.run(makeWrittenEvent({ data: { before: undefined, after: snapshot } }));
	}
};

const wrapWithRawBody = (target: unknown) => {
	const wrapper = express();
	wrapper.use(
		express.raw({ type: () => true, limit: '10mb' }),
		(req, res, next) => {
			req.body = (req.body as Buffer).toString('utf-8');
			next();
		},
		target as unknown as express.RequestHandler,
	);
	return wrapper;
};

describe('inbox Undo(Follow) processing (Issue #53)', () => {
	let originalEnv: string;
	let actor: Awaited<ReturnType<typeof apex.createActor>>;

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}

		actor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(actor);
		await apex.store.saveObject({
			id: REMOTE_ACTOR_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE_ACTOR_ID}/inbox`,
			outbox: `${REMOTE_ACTOR_ID}/outbox`,
		});
		await apex.store.saveObject({
			id: OTHER_REMOTE_ACTOR_ID,
			type: 'Person',
			preferredUsername: 'bob',
			inbox: `${OTHER_REMOTE_ACTOR_ID}/inbox`,
			outbox: `${OTHER_REMOTE_ACTOR_ID}/outbox`,
		});

		await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).set({
			id: '1',
			uid: 'firebase-uid',
			locked: false,
			bot: false,
			created_at: '2023-01-01T00:00:00.000Z',
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: '',
			emojis: [],
			fields: [],
			roles: [],
		});

		originalEnv = app.get('env') as string;
		app.set('env', 'development');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		app.set('env', originalEnv);
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	test('handles bare IRI Undo(Follow) by embedding resolved Follow, removing Follow activity, and decrementing followers_count', async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const followId = 'https://remote.example/activities/follow-1';
		const followActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: followId,
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		};

		// 1. Send Follow to inbox
		const followRes = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(followActivity));
		expect(followRes.status).toBe(200);

		// Trigger denormalization for the Follow stream
		await triggerStreamEvents(followId);

		// Verify follower is recorded in UserInfos, AP /followers, and Mastodon API getFollowers
		const userInfoAfterFollow = (
			await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get()
		).data();
		expect(userInfoAfterFollow?.followers_count).toBe(1);

		const apFollowersRes1 = await request(activitypub)
			.get('/activitypub/u/hakatashi/followers')
			.set('Accept', 'application/activity+json');
		expect(apFollowersRes1.status).toBe(200);
		expect(apFollowersRes1.body.totalItems).toBe(1);

		const mstdnFollowers1 = await getFollowers(actor);
		expect(mstdnFollowers1).toHaveLength(1);
		expect(mstdnFollowers1[0].acct).toBe('alice@remote.example');

		// 2. Send bare IRI Undo(Follow) to inbox
		const undoId = 'https://remote.example/activities/undo-1';
		const undoActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: undoId,
			type: 'Undo',
			actor: REMOTE_ACTOR_ID,
			object: followId, // Bare IRI
		};

		const undoRes = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(undoActivity));
		expect(undoRes.status).toBe(200);

		// Verify the original Follow activity was deleted from Streams
		const deletedFollow = await apex.store.getActivity(followId);
		expect(deletedFollow).toBeUndefined();

		// Verify the Undo activity in Streams has the resolved Follow object embedded
		const undoStreamDoc = await Streams.doc(escapeFirestoreKey(undoId)).get();
		expect(undoStreamDoc.exists).toBe(true);
		const undoData = undoStreamDoc.data();
		expect(undoData?.object).toEqual([
			expect.objectContaining({
				id: followId,
				type: 'Follow',
			}),
		]);

		// Trigger denormalization for the Undo stream
		await triggerStreamEvents(undoId);

		// Verify followers_count is decremented to 0
		const userInfoAfterUndo = (await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get()).data();
		expect(userInfoAfterUndo?.followers_count).toBe(0);

		// Verify AP /followers collection is now empty
		const apFollowersRes2 = await request(activitypub)
			.get('/activitypub/u/hakatashi/followers')
			.set('Accept', 'application/activity+json');
		expect(apFollowersRes2.status).toBe(200);
		expect(apFollowersRes2.body.totalItems).toBe(0);

		// Verify Mastodon API getFollowers is now empty
		const mstdnFollowers2 = await getFollowers(actor);
		expect(mstdnFollowers2).toHaveLength(0);
	});

	test('handles embedded Undo(Follow) (Mastodon format)', async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const followId = 'https://remote.example/activities/follow-2';
		const followActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: followId,
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		};

		await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(followActivity));

		await triggerStreamEvents(followId);

		const undoId = 'https://remote.example/activities/undo-2';
		const undoActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: undoId,
			type: 'Undo',
			actor: REMOTE_ACTOR_ID,
			object: {
				id: followId,
				type: 'Follow',
				actor: REMOTE_ACTOR_ID,
				object: RECIPIENT_ID,
			},
		};

		const undoRes = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(undoActivity));
		expect(undoRes.status).toBe(200);

		const deletedFollow = await apex.store.getActivity(followId);
		expect(deletedFollow).toBeUndefined();

		await triggerStreamEvents(undoId);

		const userInfo = (await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get()).data();
		expect(userInfo?.followers_count).toBe(0);

		const apFollowers = await request(activitypub)
			.get('/activitypub/u/hakatashi/followers')
			.set('Accept', 'application/activity+json');
		expect(apFollowers.body.totalItems).toBe(0);

		const mstdnFollowers = await getFollowers(actor);
		expect(mstdnFollowers).toHaveLength(0);
	});

	test('rejects Undo of a Follow owned by a different actor with 403 Forbidden', async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const followId = 'https://remote.example/activities/follow-3';
		const followActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: followId,
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		};

		await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(followActivity));

		await triggerStreamEvents(followId);

		// Bob tries to Undo Alice's follow
		const undoId = 'https://remote.example/activities/undo-3';
		const undoActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: undoId,
			type: 'Undo',
			actor: OTHER_REMOTE_ACTOR_ID,
			object: followId,
		};

		const undoRes = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(undoActivity));
		expect(undoRes.status).toBe(403);

		// Verify Alice's follow is NOT deleted
		const follow = await apex.store.getActivity(followId);
		expect(follow).toBeDefined();

		const userInfo = (await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get()).data();
		expect(userInfo?.followers_count).toBe(1);
	});

	test('succeeds safely when Undo targets an unknown / already deleted activity', async () => {
		const undoId = 'https://remote.example/activities/undo-unknown';
		const undoActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: undoId,
			type: 'Undo',
			actor: REMOTE_ACTOR_ID,
			object: 'https://remote.example/activities/follow-nonexistent',
		};

		const undoRes = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(undoActivity));
		expect(undoRes.status).toBe(200);

		await triggerStreamEvents(undoId);

		// followers_count should remain 0
		const userInfo = (await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get()).data();
		expect(userInfo?.followers_count).toBe(0);
	});
});
