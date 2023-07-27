import {describe, expect, test, afterEach, jest, beforeEach} from '@jest/globals';
import request from 'supertest';
import {activitypub, apex} from '../../src/activitypub.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';

describe('activitypub', () => {
	jest.setTimeout(10000);

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
});
