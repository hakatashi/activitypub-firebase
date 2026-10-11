import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { TransientFetchError } from '../../src/apex/pub/fetchErrors.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { localInboxId } from '../../src/localActor.js';
import { Objects, Streams } from '../../src/schema.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';
const NEW_ACTOR_ID = 'https://new.example/u/alice';

const wrapWithRawBody = (target: unknown) => {
	const wrapper = express();
	wrapper.use(
		express.raw({ type: () => true, limit: '10mb' }),
		(req, res, next) => {
			(req as { rawBody?: unknown }).rawBody = req.body;
			req.body = (req.body as Buffer).toString('utf-8');
			next();
		},
		target as unknown as express.RequestHandler,
	);
	return wrapper;
};

const postInbox = (activity: unknown) =>
	request(wrapWithRawBody(activitypub))
		.post('/activitypub/u/hakatashi/inbox')
		.set('Content-Type', 'application/activity+json')
		.send(JSON.stringify(activity));

const streamCollections = async (id: string) => {
	const doc = await Streams.doc(escapeFirestoreKey(id)).get();
	return doc.exists ? ((doc.data()?._meta?.collection as string[] | undefined) ?? []) : undefined;
};

// 引っ越しで届く Follow と、副次的に届くアクティビティの応答 (ADR-0115 / Issue #260)
describe('inbox responses to transient failures and migration side activities', () => {
	let originalEnv: string;

	beforeEach(async () => {
		await createLocalActor('hakatashi', {
			uid: 'firebase-uid',
			id: '1',
			userInfo: { created_at: '2023-01-01T00:00:00.000Z' },
		});
		await apex.store.saveObject({
			id: REMOTE_ACTOR_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE_ACTOR_ID}/inbox`,
			outbox: `${REMOTE_ACTOR_ID}/outbox`,
		});
		// 引っ越し先などの未知の actor を取りに行かない
		vi.spyOn(apex, 'requestObject').mockRejectedValue(new Error('network disabled in test'));
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		// 署名検証を省略する (development では送信者を actor から解決する)
		originalEnv = app.get('env') as string;
		app.set('env', 'development');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		app.set('env', originalEnv);
		await resetFirestore();
	});

	test('accepts Block with 2xx and stores it in the inbox', async () => {
		const id = 'https://remote.example/activities/block-1';
		const res = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Block',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		});

		expect(res.status).toBe(200);
		expect(await streamCollections(id)).toContain(localInboxId);
	});

	test('accepts Move with 2xx and stores it in the inbox', async () => {
		const id = 'https://remote.example/activities/move-1';
		const res = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Move',
			actor: REMOTE_ACTOR_ID,
			object: REMOTE_ACTOR_ID,
			target: NEW_ACTOR_ID,
			to: [`${REMOTE_ACTOR_ID}/followers`],
		});

		expect(res.status).toBe(200);
		expect(await streamCollections(id)).toContain(localInboxId);
	});

	test('accepts Update(Person) announcing the move with 2xx and updates the actor', async () => {
		const res = await postInbox({
			'@context': [
				'https://www.w3.org/ns/activitystreams',
				{ movedTo: { '@id': 'as:movedTo', '@type': '@id' } },
			],
			id: `${REMOTE_ACTOR_ID}#updates/1`,
			type: 'Update',
			actor: REMOTE_ACTOR_ID,
			object: {
				id: REMOTE_ACTOR_ID,
				type: 'Person',
				preferredUsername: 'alice',
				name: 'Alice (moved)',
				inbox: `${REMOTE_ACTOR_ID}/inbox`,
				outbox: `${REMOTE_ACTOR_ID}/outbox`,
				movedTo: NEW_ACTOR_ID,
			},
			to: ['https://www.w3.org/ns/activitystreams#Public'],
		});

		expect(res.status).toBe(200);
		const actor = await Objects.doc(escapeFirestoreKey(REMOTE_ACTOR_ID)).get();
		expect(actor.data()?.name).toEqual(['Alice (moved)']);
	});

	test('returns 500 (not a 4xx) when the store fails while saving a Follow', async () => {
		// Firestore のトランザクション競合を模す。Express 既定のハンドラは err.status を応答に使うため、
		// 4xx の status を持つ例外でも 500 になることを確認する
		const aborted = Object.assign(new Error('10 ABORTED: Transaction lock timeout'), {
			code: 10,
			status: 409,
		});
		vi.spyOn(apex.store, 'saveActivity').mockRejectedValueOnce(aborted);

		const id = 'https://remote.example/activities/follow-aborted';
		const follow = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		};
		const first = await postInbox(follow);
		expect(first.status).toBe(500);

		// 送信側の再送で受理される
		const retry = await postInbox(follow);
		expect(retry.status).toBe(200);
		expect(await streamCollections(id)).toContain(localInboxId);
	});

	test('returns 503 when an external @context of a Follow cannot be fetched temporarily', async () => {
		const contextUrl = 'https://contexts.example/ns/transient.jsonld';
		const originalLoader = apex.jsonldContextLoader;
		vi.spyOn(apex, 'jsonldContextLoader').mockImplementation(function (
			this: typeof apex,
			url: string,
		) {
			if (url === contextUrl) {
				return Promise.reject(new TransientFetchError('Request failed with status code 503'));
			}
			return originalLoader.call(this, url);
		});

		const res = await postInbox({
			'@context': ['https://www.w3.org/ns/activitystreams', contextUrl],
			id: 'https://remote.example/activities/follow-context',
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		});

		expect(res.status).toBe(503);
	});
});
