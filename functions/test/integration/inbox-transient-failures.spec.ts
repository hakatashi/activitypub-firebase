import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { PermanentFetchError, TransientFetchError } from '../../src/apex/pub/fetchErrors.js';
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

	test('accepts Follow with https://w3id.org/identity/v1 context without network access (ADR-0157, Issue #325)', async () => {
		const getContextSpy = vi.spyOn(apex.store, 'getContext');
		const id = 'https://remote.example/activities/follow-identity-v1';
		const res = await postInbox({
			'@context': [
				'https://w3id.org/identity/v1',
				'https://www.w3.org/ns/activitystreams',
				'https://w3id.org/security/v1',
			],
			id,
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		});

		expect(res.status).toBe(200);
		expect(await streamCollections(id)).toContain(localInboxId);
		expect(getContextSpy).not.toHaveBeenCalledWith('https://w3id.org/identity/v1');
	});

	test('accepts Announce with 200 and discards it when third-party object fails with 401 (ADR-0158, Issue #322)', async () => {
		const targetNoteId = 'https://cardinal.example/notes/117439778278908516';
		vi.spyOn(apex, 'requestObject').mockImplementation((id: string) => {
			if (id === targetNoteId) {
				return Promise.reject(new PermanentFetchError('Request failed with status code 401', 401));
			}
			return Promise.reject(new Error(`unexpected fetch ${id}`));
		});

		const id = 'https://remote.example/activities/announce-401';
		const res = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Announce',
			actor: REMOTE_ACTOR_ID,
			object: targetNoteId,
			to: ['https://www.w3.org/ns/activitystreams#Public'],
		});

		expect(res.status).toBe(200);
		// discarded: not stored in streams or inbox collection
		expect(await streamCollections(id)).toBeUndefined();
	});

	test('accepts Like with 200 and discards it when third-party object fails with 404 (ADR-0158, Issue #322)', async () => {
		const targetNoteId = 'https://nijimiss.example/notes/01M4YWS3N2HDZBRSY6Y58HHZ5A';
		vi.spyOn(apex, 'requestObject').mockImplementation((id: string) => {
			if (id === targetNoteId) {
				return Promise.reject(new PermanentFetchError('Request failed with status code 404', 404));
			}
			return Promise.reject(new Error(`unexpected fetch ${id}`));
		});

		const id = 'https://remote.example/activities/like-404';
		const res = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Like',
			actor: REMOTE_ACTOR_ID,
			object: targetNoteId,
			to: ['https://www.w3.org/ns/activitystreams#Public'],
		});

		expect(res.status).toBe(200);
		// discarded: not stored in streams
		expect(await streamCollections(id)).toBeUndefined();
	});

	test('returns 500 when third-party object fails with transient error (ADR-0115, Issue #322)', async () => {
		const targetNoteId = 'https://cardinal.example/notes/transient-500';
		vi.spyOn(apex, 'requestObject').mockImplementation((id: string) => {
			if (id === targetNoteId) {
				return Promise.reject(new TransientFetchError('Request failed with status code 500'));
			}
			return Promise.reject(new Error(`unexpected fetch ${id}`));
		});

		const id = 'https://remote.example/activities/announce-500';
		const res = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Announce',
			actor: REMOTE_ACTOR_ID,
			object: targetNoteId,
			to: ['https://www.w3.org/ns/activitystreams#Public'],
		});

		expect(res.status).toBe(500);
		expect(await streamCollections(id)).toBeUndefined();
	});

	test('accepts Add(Note) with 2xx without fetching the Note when target is not featured (ADR-0141, Issue #363)', async () => {
		const requestObjectSpy = vi.spyOn(apex, 'requestObject');
		const targetNoteId = `${REMOTE_ACTOR_ID}/statuses/note-1`;
		const id = 'https://remote.example/activities/add-1';
		const res = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Add',
			actor: REMOTE_ACTOR_ID,
			object: targetNoteId,
			target: `${REMOTE_ACTOR_ID}/collections/custom`,
		});

		expect(res.status).toBe(200);
		expect(requestObjectSpy).not.toHaveBeenCalledWith(targetNoteId);
		expect(await streamCollections(id)).toContain(localInboxId);
	});

	test('accepts Remove(Note) with 2xx without fetching the Note when target is not featured (ADR-0141, Issue #363)', async () => {
		const requestObjectSpy = vi.spyOn(apex, 'requestObject');
		const targetNoteId = `${REMOTE_ACTOR_ID}/statuses/note-1`;
		const id = 'https://remote.example/activities/remove-1';
		const res = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Remove',
			actor: REMOTE_ACTOR_ID,
			object: targetNoteId,
			target: `${REMOTE_ACTOR_ID}/collections/custom`,
		});

		expect(res.status).toBe(200);
		expect(requestObjectSpy).not.toHaveBeenCalledWith(targetNoteId);
		expect(await streamCollections(id)).toContain(localInboxId);
	});

	test('accepts Add(Note) and Remove(Note) with 2xx when Note is already in local store (ADR-0141, Issue #363)', async () => {
		const targetNoteId = `${REMOTE_ACTOR_ID}/statuses/local-note`;
		await apex.store.saveObject({
			id: targetNoteId,
			type: 'Note',
			attributedTo: REMOTE_ACTOR_ID,
			content: 'local note content',
		});

		const addId = 'https://remote.example/activities/add-local-note';
		const addRes = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: addId,
			type: 'Add',
			actor: REMOTE_ACTOR_ID,
			object: targetNoteId,
			target: `${REMOTE_ACTOR_ID}/collections/custom`,
		});
		expect(addRes.status).toBe(200);

		const removeId = 'https://remote.example/activities/remove-local-note';
		const removeRes = await postInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: removeId,
			type: 'Remove',
			actor: REMOTE_ACTOR_ID,
			object: targetNoteId,
			target: `${REMOTE_ACTOR_ID}/collections/custom`,
		});
		expect(removeRes.status).toBe(200);
	});
});
