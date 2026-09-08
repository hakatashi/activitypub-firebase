import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { activitypub, apex, app } from '../../src/activitypub.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';

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

describe('/inbox as:Public addressing normalization (Issue #54)', () => {
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

	test.each([
		['as:Public', 'as:Public'],
		['full URI', 'https://www.w3.org/ns/activitystreams#Public'],
		['bare Public', 'Public'],
	])(
		'normalizes public address with %s and makes isPublic() true',
		async (_label, publicTarget) => {
			const activityId = `https://remote.example/activities/create-${encodeURIComponent(publicTarget)}`;
			const objectId = `https://remote.example/notes/note-${encodeURIComponent(publicTarget)}`;

			const createActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: activityId,
				type: 'Create',
				actor: REMOTE_ACTOR_ID,
				to: [publicTarget],
				object: {
					id: objectId,
					type: 'Note',
					attributedTo: REMOTE_ACTOR_ID,
					to: [publicTarget],
					content: 'Hello Public world',
				},
			};

			const res = await request(wrapWithRawBody(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', 'application/activity+json')
				.send(JSON.stringify(createActivity));

			expect(res.status).toBe(200);

			const savedActivity = await apex.store.getActivity(activityId);
			expect(savedActivity).toBeDefined();
			if (savedActivity) {
				expect(apex.isPublic(savedActivity)).toBe(true);
			}

			const savedObject = await apex.store.getObject(objectId);
			expect(savedObject).toBeDefined();
			if (savedObject) {
				expect(apex.isPublic(savedObject)).toBe(true);
			}
		},
	);

	test('anonymous GET /inbox includes activities addressed with bare "Public"', async () => {
		const activityId = 'https://remote.example/activities/create-bare-public';
		const objectId = 'https://remote.example/notes/note-bare-public';

		const createActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: activityId,
			type: 'Create',
			actor: REMOTE_ACTOR_ID,
			to: ['Public'],
			object: {
				id: objectId,
				type: 'Note',
				attributedTo: REMOTE_ACTOR_ID,
				to: ['Public'],
				content: 'Public note with bare Public term',
			},
		};

		const postRes = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(createActivity));

		expect(postRes.status).toBe(200);

		// 匿名(未認証)リクエストで inbox ページを取得
		const getRes = await request(activitypub)
			.get('/activitypub/u/hakatashi/inbox?page=true')
			.set('Accept', 'application/activity+json');

		expect(getRes.status).toBe(200);
		expect(getRes.body.orderedItems).toBeDefined();
		const items = getRes.body.orderedItems as { id: string }[];
		expect(items.some((item) => item.id === activityId)).toBe(true);
	});
});
