import request from 'supertest';
import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

describe('mastodon', () => {
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
		const response = await request(mastodon).get('/');
		expect(response.status).toBe(404);
	});

	describe('/api', () => {
		describe('/api/v1/instance', () => {
			test('Returns instance information', async () => {
				const response = await request(mastodon).get('/api/v1/instance');
				expect(response.status).toBe(200);
				expect(response.body.uri).toBe('mastodon-dev.hakatashi.com');
				expect(response.body.title).toBe('HakataFediverse');
			});
		});

		describe('/api/v2/instance', () => {
			test('Returns instance information', async () => {
				const response = await request(mastodon).get('/api/v2/instance');
				expect(response.status).toBe(200);
				expect(response.body.domain).toBe('mastodon-dev.hakatashi.com');
				expect(response.body.title).toBe('HakataFediverse');
			});
		});

		describe('/api/v1/accounts/lookup', () => {
			test('returns 404 when acct is missing or empty', async () => {
				const response = await request(mastodon).get('/api/v1/accounts/lookup');
				expect(response.status).toBe(404);
				expect(response.body.error).toBe('Record not found');
			});

			test('returns 404 when acct does not exist', async () => {
				const response = await request(mastodon).get('/api/v1/accounts/lookup').query({
					acct: 'nonexistent',
				});
				expect(response.status).toBe(404);
				expect(response.body.error).toBe('Record not found');
			});
		});

		describe('/api/v1/accounts/:id/followers', () => {
			test('returns 404 when user id does not exist', async () => {
				const response = await request(mastodon).get('/api/v1/accounts/unknown-id/followers');
				expect(response.status).toBe(404);
				expect(response.body.error).toBe('Record not found');
			});
		});

		describe('/api/v1/apps', () => {
			test('returns 400 when required fields are missing', async () => {
				const response = await request(mastodon).post('/api/v1/apps').send({
					client_name: 'Test App',
					// missing redirect_uris
				});
				expect(response.status).toBe(400);
			});

			test('returns 400 when invalid scopes are specified', async () => {
				const response = await request(mastodon).post('/api/v1/apps').send({
					client_name: 'Test App',
					redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
					scopes: 'read invalid:scope',
				});
				expect(response.status).toBe(400);
			});

			test('creates a new app with valid parameters', async () => {
				const response = await request(mastodon).post('/api/v1/apps').send({
					client_name: 'Test App',
					redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
					scopes: 'read write follow',
					website: 'https://example.com',
				});
				expect(response.status).toBe(200);
				expect(response.body.name).toBe('Test App');
				expect(response.body.redirect_uri).toBe('urn:ietf:wg:oauth:2.0:oob');
				expect(response.body.client_id).toEqual(expect.any(String));
				expect(response.body.client_secret).toEqual(expect.any(String));
			});
		});
	});
});
