import express from 'express';
import request from 'supertest';
import { describe, expect, test, afterEach, beforeEach, vi } from 'vitest';
import oauthRouter from '../../src/mastodon/oauth.js';
import { Clients, Users } from '../../src/schema.js';

vi.mock('node-fetch');

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

// mastodonApi (src/mastodon/index.ts) 自体は body-parser を持たず、本番では
// Cloud Functions Framework が req.body を解決してから oauthRouter に渡す。
// この前提を supertest から再現するため、ここでは同じミドルウェアを自前で挟む。
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/oauth', oauthRouter);

describe('oauth', () => {
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

	describe('POST /oauth/token', () => {
		beforeEach(async () => {
			await Users.add({ id: 'user-1', username: 'hakatashi', password: 'hunter2' });
			await Clients.add({
				id: '1',
				name: 'test client',
				redirectUris: 'https://example.com/callback',
				grants: ['client_credentials'],
				clientId: 'client-id',
				clientSecret: 'client-secret',
				scopes: ['read'],
				vapidKey: 'vapid-key',
				userId: 'user-1',
			});
		});

		test('issues an access token for the client_credentials grant', async () => {
			const response = await request(app).post('/oauth/token').type('form').send({
				grant_type: 'client_credentials',
				client_id: 'client-id',
				client_secret: 'client-secret',
				scope: 'read',
			});

			expect(response.status).toBe(200);
			expect(response.body.access_token).toEqual(expect.any(String));
			expect(response.body.token_type).toBe('Bearer');
			expect(response.body.scope).toBe('read');
		});

		test('rejects an unknown client', async () => {
			const response = await request(app).post('/oauth/token').type('form').send({
				grant_type: 'client_credentials',
				client_id: 'unknown-client',
				client_secret: 'wrong-secret',
			});

			expect(response.status).toBe(400);
		});

		test('accepts a JSON body as a workaround for clients that send the wrong content type', async () => {
			// https://github.com/elk-zone/elk/issues/2244
			const response = await request(app).post('/oauth/token').send({
				grant_type: 'client_credentials',
				client_id: 'client-id',
				client_secret: 'client-secret',
				scope: 'read',
			});

			expect(response.status).toBe(200);
			expect(response.body.access_token).toEqual(expect.any(String));
		});

		test('rejects request with missing grant_type', async () => {
			const response = await request(app).post('/oauth/token').type('form').send({
				client_id: 'client-id',
				client_secret: 'client-secret',
			});

			expect(response.status).toBe(400);
		});
	});

	describe('GET /oauth/authorize', () => {
		test('rejects missing or invalid query parameters', async () => {
			const response1 = await request(app).get('/oauth/authorize');
			expect(response1.status).toBe(400);

			const response2 = await request(app).get('/oauth/authorize').query({
				client_id: 'client-id',
				// missing redirect_uri and response_type
			});
			expect(response2.status).toBe(400);
		});

		test('renders authorization page on valid query parameters', async () => {
			const { default: firebase } = await import('firebase-admin');
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);

			const { default: fetch, Response } = await import('node-fetch');
			const fetchMock = vi.mocked(fetch);
			fetchMock
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					statusText: 'OK',
					json: () => Promise.resolve({ apps: [{ appId: 'test-app-id' }] }),
				} as unknown as typeof Response.prototype)
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					statusText: 'OK',
					json: () => Promise.resolve({ apiKey: 'fake-api-key', appId: 'test-app-id' }),
				} as unknown as typeof Response.prototype);

			try {
				const response = await request(app).get('/oauth/authorize').query({
					client_id: 'client-id',
					redirect_uri: 'https://example.com/callback',
					response_type: 'code',
					scope: 'read',
				});
				expect(response.status).toBe(200);
				expect(response.text).toContain('name="client_id" id="client_id" value="client-id"');
			} finally {
				credentialSpy.mockRestore();
			}
		});

		test('returns 500 if external webapp config retrieval fails', async () => {
			const { default: firebase } = await import('firebase-admin');
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.reject(new Error('ADC failure')),
			} as unknown as firebase.credential.Credential);

			try {
				const response = await request(app).get('/oauth/authorize').query({
					client_id: 'client-id',
					redirect_uri: 'https://example.com/callback',
					response_type: 'code',
					scope: 'read',
				});
				expect(response.status).toBe(500);
			} finally {
				credentialSpy.mockRestore();
			}
		});

		test('returns 500 if Firebase WebApps API returns non-ok status', async () => {
			const { default: firebase } = await import('firebase-admin');
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);

			const { default: fetch, Response } = await import('node-fetch');
			const fetchMock = vi.mocked(fetch);
			fetchMock.mockResolvedValueOnce({
				ok: false,
				status: 403,
				statusText: 'Forbidden',
			} as unknown as typeof Response.prototype);

			try {
				const response = await request(app).get('/oauth/authorize').query({
					client_id: 'client-id',
					redirect_uri: 'https://example.com/callback',
					response_type: 'code',
					scope: 'read',
				});
				expect(response.status).toBe(500);
			} finally {
				credentialSpy.mockRestore();
			}
		});

		test('returns 500 if Firebase WebApps API returns invalid schema', async () => {
			const { default: firebase } = await import('firebase-admin');
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);

			const { default: fetch, Response } = await import('node-fetch');
			const fetchMock = vi.mocked(fetch);
			fetchMock.mockResolvedValueOnce({
				ok: true,
				status: 200,
				statusText: 'OK',
				json: () => Promise.resolve({ apps: 'invalid-apps-format' }),
			} as unknown as typeof Response.prototype);

			try {
				const response = await request(app).get('/oauth/authorize').query({
					client_id: 'client-id',
					redirect_uri: 'https://example.com/callback',
					response_type: 'code',
					scope: 'read',
				});
				expect(response.status).toBe(500);
			} finally {
				credentialSpy.mockRestore();
			}
		});
	});

	describe('POST /oauth/authorize', () => {
		test('rejects missing idToken in body', async () => {
			const response = await request(app).post('/oauth/authorize').send({});
			expect(response.status).toBe(400);
		});
	});

	describe('POST /oauth/revoke', () => {
		test('is not implemented yet', async () => {
			const response = await request(app).post('/oauth/revoke');
			expect(response.status).toBe(501);
		});
	});
});
