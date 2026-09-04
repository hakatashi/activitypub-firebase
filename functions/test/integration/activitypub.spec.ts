import request from 'supertest';
import {describe, expect, test, afterEach, beforeEach, vi} from 'vitest';
import {activitypub, apex} from '../../src/activitypub.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';

describe('activitypub', () => {
	beforeEach(() => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
	});

	// Teardown firestore database after each test
	afterEach(async () => {
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{
				method: 'DELETE',
			},
		);
	});

	test('Root path should not be implemented', async () => {
		const response = await request(activitypub).get('/');
		expect(response.status).toBe(404);
	});

	describe('/nodeinfo', () => {
		describe('/nodeinfo/1.1', () => {
			test('Not implemented', async () => {
				const response = await request(activitypub).get('/nodeinfo/1.1');
				expect(response.status).toBe(404);
			});
		});

		describe('/nodeinfo/2.0', () => {
			test('No user registered', async () => {
				const response = await request(activitypub).get('/nodeinfo/2.0');
				expect(response.status).toBe(200);
				expect(response.body.version).toBe('2.0');
				expect(response.body.usage.users.total).toBe(0);
				expect(response.body.software.name).toBe('activitypub-firebase');
				expect(response.body.software.version).toBe('1.0.0');
			});

			test('3 users registered', async () => {
				for (const username of ['hakatashi', 'hakatashi2', 'hakatashi3']) {
					const actor = await apex.createActor(username, username, '', '', 'Person');
					await apex.store.saveObject(actor);
				}

				const response = await request(activitypub).get('/nodeinfo/2.0');
				expect(response.status).toBe(200);
				expect(response.body.usage.users.total).toBe(3);
			});
		});

		describe('/nodeinfo/2.1', () => {
			test('No user registered', async () => {
				const response = await request(activitypub).get('/nodeinfo/2.1');
				expect(response.status).toBe(200);
				expect(response.body.version).toBe('2.1');
				expect(response.body.usage.users.total).toBe(0);
				expect(response.body.software.name).toBe('activitypub-firebase');
				expect(response.body.software.version).toBe('1.0.0');
			});

			test('3 users registered', async () => {
				for (const username of ['hakatashi', 'hakatashi2', 'hakatashi3']) {
					const actor = await apex.createActor(username, username, '', '', 'Person');
					await apex.store.saveObject(actor);
				}

				const response = await request(activitypub).get('/nodeinfo/2.1');
				expect(response.status).toBe(200);
				expect(response.body.usage.users.total).toBe(3);
			});
		});
	});

	describe('/.well-known', () => {
		describe('/.well-known/webfinger', () => {
			beforeEach(async () => {
				const actor = await apex.createActor('hakatashi', 'Koki Takahashi', '', '', 'Person');
				await apex.store.saveObject(actor);
			});

			test('Non-existent user', async () => {
				const response = await request(activitypub).get(`/.well-known/webfinger?resource=acct:notfound@${DEV_DOMAIN}`);
				expect(response.status).toBe(404);
			});

			test('Existing user', async () => {
				const response = await request(activitypub).get(`/.well-known/webfinger?resource=acct:hakatashi@${DEV_DOMAIN}`);
				expect(response.status).toBe(200);
				expect(response.body.subject).toBe(`acct:hakatashi@${DEV_DOMAIN}`);
				expect(response.body.links).toHaveLength(1);
				expect(response.body.links[0].rel).toBe('self');
				expect(response.body.links[0].type).toBe('application/activity+json');
				expect(response.body.links[0].href).toBe(`https://${DEV_DOMAIN}/activitypub/u/hakatashi`);
			});
		});

		describe('/.well-known/nodeinfo', () => {
			test('Returns nodeinfo', async () => {
				const response = await request(activitypub).get('/.well-known/nodeinfo');
				expect(response.status).toBe(200);
				expect(response.body.links).toHaveLength(2);
				expect(response.body.links).toContainEqual({
					rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
					href: `https://${DEV_DOMAIN}/nodeinfo/2.0`,
				});
				expect(response.body.links).toContainEqual({
					rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
					href: `https://${DEV_DOMAIN}/nodeinfo/2.1`,
				});
			});
		});
	});

	describe('/activitypub/deliveries', () => {
		const adminHeader = {'x-hakatashi-token': 'test-token'};

		beforeEach(() => {
			process.env.HAKATASHI_TOKEN = 'test-token';
		});

		afterEach(() => {
			vi.restoreAllMocks();
			delete process.env.HAKATASHI_TOKEN;
		});

		test('GET /failed rejects requests without the admin token', async () => {
			const response = await request(activitypub).get('/activitypub/deliveries/failed');
			expect(response.status).toBe(403);
		});

		test('GET /failed lists only permanent_failure/retrying deliveries', async () => {
			await apex.store.recordDeliveryResult({
				activityId: 'https://example.com/activities/1',
				actorId: 'https://example.com/users/hakatashi',
				address: 'https://remote.example/u/alice/inbox',
				body: '{"id":"https://example.com/activities/1","type":"Create"}',
				attempts: 1,
				status: 'permanent_failure',
				statusCode: 410,
			});
			await apex.store.recordDeliveryResult({
				activityId: 'https://example.com/activities/2',
				actorId: 'https://example.com/users/hakatashi',
				address: 'https://remote.example/u/bob/inbox',
				body: '{"id":"https://example.com/activities/2","type":"Create"}',
				attempts: 1,
				status: 'success',
				statusCode: 202,
			});

			const response = await request(activitypub).get('/activitypub/deliveries/failed').set(adminHeader);
			expect(response.status).toBe(200);
			expect(response.body).toHaveLength(1);
			expect(response.body[0].status).toBe('permanent_failure');
		});

		test('POST /resend re-enqueues the stored delivery body to the given inbox', async () => {
			const activityId = 'https://example.com/activities/3';
			const actorId = 'https://example.com/users/hakatashi';
			const address = 'https://remote.example/u/carol/inbox';
			const body = `{"id":"${activityId}","type":"Create"}`;
			await apex.store.recordDeliveryResult({
				activityId, actorId, address, body, attempts: 1, status: 'permanent_failure', statusCode: 410,
			});

			const enqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

			const response = await request(activitypub)
				.post('/activitypub/deliveries/resend')
				.set(adminHeader)
				.send({activityId, inbox: address});

			expect(response.status).toBe(200);
			expect(enqueueSpy).toHaveBeenCalledWith(actorId, body, address, undefined);
		});

		test('POST /resend 404s for an unknown activity/inbox pair', async () => {
			const response = await request(activitypub)
				.post('/activitypub/deliveries/resend')
				.set(adminHeader)
				.send({activityId: 'https://example.com/activities/unknown', inbox: 'https://remote.example/inbox'});

			expect(response.status).toBe(404);
		});
	});
});
