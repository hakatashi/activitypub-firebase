import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, apex, app } from '../../src/activitypub.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';

// inbox-dedup.spec.ts と同じ理由(Cloud Functions ランタイムの req.rawBody 前提の再現)。
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

// Issue #55 の dev 実地検証で、匿名の GET /followers?page=true が承認済みの Follow を
// 一切返さない不具合を発見した(totalItems は正しいのに orderedItems が常に空)。
// 原因は Follow が to/cc を持たないため apex.isPublic() が false になり、
// getCollection の匿名向けフィルタで毎回除外されること (→ ADR-0035)。
describe('anonymous GET /followers?page=true after auto-accept (Issue #55, ADR-0035)', () => {
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

		// security.verifySignature は development env でのみ Signature ヘッダなしを許す
		// (→ inbox-dedup.spec.ts と同じバイパス)。
		app.set('env', 'development');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	test('lists the newly accepted follower without authentication', async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const followActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		};

		const followResponse = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(followActivity));
		expect(followResponse.status).toBe(200);

		const followersResponse = await request(app)
			.get('/activitypub/u/hakatashi/followers')
			.query({ page: 'true' })
			.set('Accept', 'application/activity+json');

		expect(followersResponse.status).toBe(200);
		expect(followersResponse.body.orderedItems).toEqual([REMOTE_ACTOR_ID]);
	});
});
