import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { resetFirestore } from '../helpers/index.js';

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';

const JSONLD_CONTENT_TYPES = [
	'application/activity+json',
	'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
];

// Cloud Functions のランタイム (functions-framework 3.x) の本文の解析を再現する。
// JSON-LD の Content-Type は json / text のどちらの parser にも合わず、最後の raw に落ちて Buffer になる。
// 本文のない要求では、body-parser 1.x が req.body に {} を残す (#311)。
const wrapLikeFunctionsFramework = (target: unknown) => {
	const wrapper = express();
	wrapper.use(
		express.raw({ type: () => true, limit: '10mb' }),
		(req, _res, next) => {
			(req as { rawBody?: unknown }).rawBody = req.body;
			if (req.body === undefined) {
				req.body = {};
			}
			next();
		},
		target as unknown as express.RequestHandler,
	);
	return wrapper;
};

describe('request body parsing in the Cloud Functions runtime (#311)', () => {
	beforeEach(async () => {
		const actor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(actor);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	// Bridgy Fed は GET にも Content-Type を付ける
	test.each(JSONLD_CONTENT_TYPES)(
		'GET the actor with Content-Type %s returns 200',
		async (contentType) => {
			const response = await request(wrapLikeFunctionsFramework(activitypub))
				.get('/activitypub/u/hakatashi')
				.set('Accept', 'application/activity+json')
				.set('Content-Type', contentType);

			expect(response.status).toBe(200);
			expect(response.body.id).toBe(RECIPIENT_ID);
		},
	);

	test.each(JSONLD_CONTENT_TYPES)(
		'POST to the inbox with a raw body and Content-Type %s is processed',
		async (contentType) => {
			await apex.store.saveObject({
				id: REMOTE_ACTOR_ID,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${REMOTE_ACTOR_ID}/inbox`,
				outbox: `${REMOTE_ACTOR_ID}/outbox`,
			});
			// security.verifySignature は development env でのみ Signature ヘッダなしを許す
			app.set('env', 'development');
			vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

			const response = await request(wrapLikeFunctionsFramework(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', contentType)
				.send(
					JSON.stringify({
						'@context': 'https://www.w3.org/ns/activitystreams',
						id: 'https://remote.example/activities/follow-1',
						type: 'Follow',
						actor: REMOTE_ACTOR_ID,
						object: RECIPIENT_ID,
					}),
				);

			expect(response.status).toBe(200);
		},
	);
});
