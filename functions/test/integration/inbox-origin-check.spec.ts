import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { activitypub, apex, app } from '../../src/activitypub.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';
const LOCAL_OBJECT_ID = `https://${DEV_DOMAIN}/activitypub/o/local-note`;
const REMOTE_OBJECT_ID = 'https://remote.example/o/remote-note';

// test/integration/inbox-dedup.spec.ts と同じ理由で、Cloud Functions ランタイムの
// 生 body 前処理を再現する必要がある。
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

describe('/inbox Update / Delete same-origin check (Issue #51)', () => {
	let originalEnv: string;

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}

		const actor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(actor);
		await apex.store.saveObject({
			id: REMOTE_ACTOR_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE_ACTOR_ID}/inbox`,
			outbox: `${REMOTE_ACTOR_ID}/outbox`,
		});
		await apex.store.saveObject({
			id: LOCAL_OBJECT_ID,
			type: 'Note',
			attributedTo: [RECIPIENT_ID],
			content: ['original local content'],
		});
		await apex.store.saveObject({
			id: REMOTE_OBJECT_ID,
			type: 'Note',
			attributedTo: [REMOTE_ACTOR_ID],
			content: ['original remote content'],
		});

		// security.verifySignature は Signature ヘッダがない場合 development env でのみ
		// 通過を許す(それ以外は 401)。HTTP 署名の実装自体はこの Issue のスコープ外なので、
		// ここでは development バイパスを使って同一オリジン検証だけを検証する。
		originalEnv = app.get('env') as string;
		app.set('env', 'development');
	});

	afterEach(async () => {
		app.set('env', originalEnv);
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	const postToInbox = (activity: unknown) =>
		request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(activity));

	test('rejects a Delete for a local object signed by a different-origin actor', async () => {
		const response = await postToInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/delete-1',
			type: 'Delete',
			actor: REMOTE_ACTOR_ID,
			object: LOCAL_OBJECT_ID,
		});

		expect(response.status).toBe(403);

		const stored = await apex.store.getObject(LOCAL_OBJECT_ID);
		expect(stored?.type).not.toBe('Tombstone');
	});

	test('rejects an Update whose inline object spoofs attributedTo to bypass ownership but targets a foreign-origin id', async () => {
		const response = await postToInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/update-1',
			type: 'Update',
			actor: REMOTE_ACTOR_ID,
			object: {
				id: LOCAL_OBJECT_ID,
				type: 'Note',
				attributedTo: REMOTE_ACTOR_ID,
				content: 'hijacked content',
			},
		});

		expect(response.status).toBe(403);

		const stored = await apex.store.getObject(LOCAL_OBJECT_ID);
		expect(stored?.content?.[0]).toBe('original local content');
	});

	test('allows a Delete for a remote object signed by its own-origin actor', async () => {
		const response = await postToInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/delete-2',
			type: 'Delete',
			actor: REMOTE_ACTOR_ID,
			object: REMOTE_OBJECT_ID,
		});

		expect(response.status).toBe(200);

		const stored = await apex.store.getObject(REMOTE_OBJECT_ID);
		expect(stored?.type).toBe('Tombstone');
	});

	test('allows an Update for a remote object signed by its own-origin actor', async () => {
		const response = await postToInbox({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/update-2',
			type: 'Update',
			actor: REMOTE_ACTOR_ID,
			object: {
				id: REMOTE_OBJECT_ID,
				type: 'Note',
				attributedTo: REMOTE_ACTOR_ID,
				content: 'edited remote content',
			},
		});

		expect(response.status).toBe(200);

		const stored = await apex.store.getObject(REMOTE_OBJECT_ID);
		expect(stored?.content?.[0]).toBe('edited remote content');
	});
});
