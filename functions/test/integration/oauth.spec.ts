import crypto from 'node:crypto';
import express from 'express';
import firebase from 'firebase-admin';
import nock from 'nock';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import apiRouter from '../../src/mastodon/api.js';
import oauthRouter from '../../src/mastodon/oauth.js';
import { AccessTokens, Clients, RefreshTokens, Users } from '../../src/schema.js';
import { resetFirestore } from '../helpers/firestore.js';

// mastodonApi (src/mastodon/index.ts) 自体は body-parser を持たず、本番では
// Cloud Functions Framework が req.body を解決してから oauthRouter に渡す。
// この前提を supertest から再現するため、ここでは同じミドルウェアを自前で挟む。
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/oauth', oauthRouter);
app.use('/api', apiRouter);

describe('oauth', () => {
	// Teardown firestore database after each test
	afterEach(async () => {
		await resetFirestore();
	});

	describe('POST /oauth/token', () => {
		beforeEach(async () => {
			await Users.add({ id: 'user-1', username: 'hakatashi', password: 'hunter2' });
			await Clients.add({
				id: '1',
				name: 'test client',
				redirectUris: 'https://example.com/callback',
				grants: ['client_credentials', 'refresh_token'],
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

		test('issues a new access token and refresh token for refresh_token grant and revokes the old one', async () => {
			const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
			await RefreshTokens.add({
				refreshToken: 'old-refresh-token',
				refreshTokenExpiresAt: farFuture,
				client: {
					id: '1',
					name: 'test client',
					redirectUris: ['https://example.com/callback'],
					grants: ['refresh_token'],
					clientId: 'client-id',
					clientSecret: 'client-secret',
					scopes: ['read'],
					vapidKey: 'vapid-key',
				},
				user: { id: 'user-1' },
				scope: 'read',
			});

			const response = await request(app).post('/oauth/token').type('form').send({
				grant_type: 'refresh_token',
				refresh_token: 'old-refresh-token',
				client_id: 'client-id',
				client_secret: 'client-secret',
			});

			expect(response.status).toBe(200);
			expect(response.body.access_token).toEqual(expect.any(String));
			expect(response.body.refresh_token).toEqual(expect.any(String));
			expect(response.body.refresh_token).not.toBe('old-refresh-token');

			// Old refresh token must be revoked
			const oldDoc = await RefreshTokens.where('refreshToken', '==', 'old-refresh-token').get();
			expect(oldDoc.empty).toBe(true);
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
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);

			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps$/)
				.reply(200, { apps: [{ appId: 'test-app-id' }] });
			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps\/test-app-id\/config$/)
				.reply(200, { apiKey: 'fake-api-key', appId: 'test-app-id' });

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

		test('renders authorization page with state and PKCE hidden inputs', async () => {
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);

			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps$/)
				.reply(200, { apps: [{ appId: 'test-app-id' }] });
			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps\/test-app-id\/config$/)
				.reply(200, { apiKey: 'fake-api-key', appId: 'test-app-id' });

			try {
				const response = await request(app).get('/oauth/authorize').query({
					client_id: 'client-id',
					redirect_uri: 'https://example.com/callback',
					response_type: 'code',
					scope: 'read',
					state: 'custom-state-value',
					code_challenge: 'custom-challenge-value',
					code_challenge_method: 'S256',
				});
				expect(response.status).toBe(200);
				expect(response.text).toContain('name="state" id="state" value="custom-state-value"');
				expect(response.text).toContain(
					'name="code_challenge" id="code_challenge" value="custom-challenge-value"',
				);
				expect(response.text).toContain(
					'name="code_challenge_method" id="code_challenge_method" value="S256"',
				);
			} finally {
				credentialSpy.mockRestore();
			}
		});

		test('returns 500 if external webapp config retrieval fails', async () => {
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
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);

			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps$/)
				.reply(403, 'Forbidden');

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
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);

			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps$/)
				.reply(200, { apps: 'invalid-apps-format' });

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
		beforeEach(async () => {
			await Clients.add({
				id: '1',
				name: 'client 1',
				redirectUris: 'https://example.com/callback',
				grants: ['authorization_code'],
				clientId: 'client-1',
				clientSecret: 'secret-1',
				scopes: ['read'],
				vapidKey: 'vapid-1',
			});
			await Clients.add({
				id: '2',
				name: 'client 2',
				redirectUris: 'https://example.com/callback',
				grants: ['authorization_code'],
				clientId: 'client-2',
				clientSecret: 'secret-2',
				scopes: ['read'],
				vapidKey: 'vapid-2',
			});
			await AccessTokens.add({
				accessToken: 'token-belonging-to-client-1',
				accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
				client: { id: '1', clientId: 'client-1', grants: [] },
				user: { id: 'user-1' },
			});
			await RefreshTokens.add({
				refreshToken: 'refresh-belonging-to-client-1',
				refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
				client: { id: '1', clientId: 'client-1', grants: [] },
				user: { id: 'user-1' },
			});
		});

		test('rejects missing client_id with 401', async () => {
			const response = await request(app).post('/oauth/revoke').type('form').send({
				token: 'some-token',
			});
			expect(response.status).toBe(401);
			expect(response.body.error).toBe('invalid_client');
		});

		test('rejects unknown client with 401', async () => {
			const response = await request(app).post('/oauth/revoke').type('form').send({
				client_id: 'unknown-client',
				token: 'some-token',
			});
			expect(response.status).toBe(401);
			expect(response.body.error).toBe('invalid_client');
		});

		test('rejects missing token with 400', async () => {
			const response = await request(app).post('/oauth/revoke').type('form').send({
				client_id: 'client-1',
				client_secret: 'secret-1',
			});
			expect(response.status).toBe(400);
			expect(response.body.error).toBe('invalid_request');
		});

		test('returns 200 for nonexistent token (idempotent)', async () => {
			const response = await request(app).post('/oauth/revoke').type('form').send({
				client_id: 'client-1',
				client_secret: 'secret-1',
				token: 'nonexistent-token',
			});
			expect(response.status).toBe(200);
			expect(response.body).toEqual({});
		});

		test('returns 403 when token belongs to another client', async () => {
			const response = await request(app).post('/oauth/revoke').type('form').send({
				client_id: 'client-2',
				client_secret: 'secret-2',
				token: 'token-belonging-to-client-1',
			});
			expect(response.status).toBe(403);
			expect(response.body.error).toBe('unauthorized_client');
		});

		test('revokes access token with credentials in body', async () => {
			const response = await request(app).post('/oauth/revoke').type('form').send({
				client_id: 'client-1',
				client_secret: 'secret-1',
				token: 'token-belonging-to-client-1',
			});
			expect(response.status).toBe(200);
			expect(response.body).toEqual({});

			const doc = await AccessTokens.where(
				'accessToken',
				'==',
				'token-belonging-to-client-1',
			).get();
			expect(doc.empty).toBe(true);
		});

		test('revokes access token with credentials in Basic auth header', async () => {
			const basic = Buffer.from('client-1:secret-1').toString('base64');
			const response = await request(app)
				.post('/oauth/revoke')
				.set('Authorization', `Basic ${basic}`)
				.type('form')
				.send({
					token: 'token-belonging-to-client-1',
				});
			expect(response.status).toBe(200);
			expect(response.body).toEqual({});

			const doc = await AccessTokens.where(
				'accessToken',
				'==',
				'token-belonging-to-client-1',
			).get();
			expect(doc.empty).toBe(true);
		});

		test('revokes refresh token', async () => {
			const response = await request(app).post('/oauth/revoke').type('form').send({
				client_id: 'client-1',
				client_secret: 'secret-1',
				token: 'refresh-belonging-to-client-1',
			});
			expect(response.status).toBe(200);
			expect(response.body).toEqual({});

			const doc = await RefreshTokens.where(
				'refreshToken',
				'==',
				'refresh-belonging-to-client-1',
			).get();
			expect(doc.empty).toBe(true);
		});
	});

	describe('OAuth full lifecycle (App registration -> Authorize with PKCE -> Token exchange -> Refresh -> Revoke)', () => {
		test('completes full OAuth lifecycle with PKCE', async () => {
			// 1. App Registration
			const appRegResponse = await request(app)
				.post('/api/v1/apps')
				.send({
					client_name: 'Full Lifecycle App',
					redirect_uris: ['https://example.com/oauth/callback', 'app://oauth/callback'],
					scopes: 'read write follow',
					website: 'https://example.com',
				});
			expect(appRegResponse.status).toBe(200);
			const {
				id: appId,
				client_id: clientId,
				client_secret: clientSecret,
				vapid_key: vapidKey,
			} = appRegResponse.body;
			expect(appId).toBeDefined();
			expect(clientId).toBeDefined();
			expect(clientSecret).toBeDefined();
			expect(vapidKey).toBeDefined();
			expect(appRegResponse.body.redirect_uris).toEqual([
				'https://example.com/oauth/callback',
				'app://oauth/callback',
			]);

			// 2. Authorize request with PKCE and state
			const verifier = crypto.randomBytes(32).toString('base64url');
			const codeChallenge = crypto.createHash('sha256').update(verifier).digest('base64url');
			const state = 'secure-state-12345';

			// Mock Firebase WebApps ADC for GET /oauth/authorize
			const credentialSpy = vi.spyOn(firebase.credential, 'applicationDefault').mockReturnValue({
				getAccessToken: () => Promise.resolve({ access_token: 'mock-token', expires_in: 3600 }),
			} as unknown as firebase.credential.Credential);
			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps$/)
				.reply(200, { apps: [{ appId: 'test-app-id' }] });
			nock('https://firebase.googleapis.com')
				.get(/\/v1beta1\/projects\/[^/]+\/webApps\/test-app-id\/config$/)
				.reply(200, { apiKey: 'fake-api-key', appId: 'test-app-id' });

			const authPageResponse = await request(app).get('/oauth/authorize').query({
				client_id: clientId,
				redirect_uri: 'https://example.com/oauth/callback',
				response_type: 'code',
				scope: 'read write',
				state,
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
			});
			expect(authPageResponse.status).toBe(200);
			expect(authPageResponse.text).toContain(`name="state" id="state" value="${state}"`);
			expect(authPageResponse.text).toContain(
				`name="code_challenge" id="code_challenge" value="${codeChallenge}"`,
			);
			expect(authPageResponse.text).toContain(
				'name="code_challenge_method" id="code_challenge_method" value="S256"',
			);
			credentialSpy.mockRestore();

			// 3. User Approves via POST /oauth/authorize
			const authSpy = vi.spyOn(firebase.auth(), 'verifyIdToken').mockResolvedValue({
				uid: 'user-uid-test',
			} as unknown as firebase.auth.DecodedIdToken);

			const approveResponse = await request(app).post('/oauth/authorize').type('form').send({
				idToken: 'valid-id-token',
				client_id: clientId,
				redirect_uri: 'https://example.com/oauth/callback',
				response_type: 'code',
				scope: 'read write',
				state,
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
			});
			expect(approveResponse.status).toBe(302);
			const location = approveResponse.headers.location;
			expect(location).toBeDefined();
			const redirectUrl = new URL(location as string);
			expect(redirectUrl.searchParams.get('state')).toBe(state);
			const authCode = redirectUrl.searchParams.get('code');
			expect(authCode).toBeTruthy();
			authSpy.mockRestore();

			// 4. Token Exchange with wrong code_verifier fails
			const failTokenResponse = await request(app).post('/oauth/token').type('form').send({
				grant_type: 'authorization_code',
				code: authCode,
				client_id: clientId,
				client_secret: clientSecret,
				redirect_uri: 'https://example.com/oauth/callback',
				code_verifier: 'incorrect-verifier',
			});
			expect(failTokenResponse.status).toBe(400);

			// 5. Token Exchange with valid code_verifier succeeds
			const tokenResponse = await request(app).post('/oauth/token').type('form').send({
				grant_type: 'authorization_code',
				code: authCode,
				client_id: clientId,
				client_secret: clientSecret,
				redirect_uri: 'https://example.com/oauth/callback',
				code_verifier: verifier,
			});
			expect(tokenResponse.status).toBe(200);
			const { access_token: accessToken1, refresh_token: refreshToken1 } = tokenResponse.body;
			expect(accessToken1).toBeDefined();
			expect(refreshToken1).toBeDefined();

			// 6. Verify credentials via GET /api/v1/apps/verify_credentials
			const credsResponse = await request(app)
				.get('/api/v1/apps/verify_credentials')
				.set('Authorization', `Bearer ${accessToken1}`);
			expect(credsResponse.status).toBe(200);
			expect(credsResponse.body).toEqual({
				id: appId,
				name: 'Full Lifecycle App',
				website: 'https://example.com',
				scopes: ['read', 'write', 'follow'],
				redirect_uri: 'https://example.com/oauth/callback',
				redirect_uris: ['https://example.com/oauth/callback', 'app://oauth/callback'],
				vapid_key: vapidKey,
			});

			// 7. Refresh token grant
			const refreshResponse = await request(app).post('/oauth/token').type('form').send({
				grant_type: 'refresh_token',
				refresh_token: refreshToken1,
				client_id: clientId,
				client_secret: clientSecret,
			});
			expect(refreshResponse.status).toBe(200);
			const { access_token: accessToken2, refresh_token: refreshToken2 } = refreshResponse.body;
			expect(accessToken2).toBeDefined();
			expect(refreshToken2).toBeDefined();
			expect(accessToken2).not.toBe(accessToken1);
			expect(refreshToken2).not.toBe(refreshToken1);

			// 8. Old refresh token cannot be reused
			const oldRefreshReplay = await request(app).post('/oauth/token').type('form').send({
				grant_type: 'refresh_token',
				refresh_token: refreshToken1,
				client_id: clientId,
				client_secret: clientSecret,
			});
			expect(oldRefreshReplay.status).toBe(400);

			// 9. New access token works
			const newCredsResponse = await request(app)
				.get('/api/v1/apps/verify_credentials')
				.set('Authorization', `Bearer ${accessToken2}`);
			expect(newCredsResponse.status).toBe(200);

			// 10. Revoke new access token
			const revokeResponse = await request(app).post('/oauth/revoke').type('form').send({
				client_id: clientId,
				client_secret: clientSecret,
				token: accessToken2,
			});
			expect(revokeResponse.status).toBe(200);
			expect(revokeResponse.body).toEqual({});

			// 11. Revoked token fails authentication
			const revokedCredsResponse = await request(app)
				.get('/api/v1/apps/verify_credentials')
				.set('Authorization', `Bearer ${accessToken2}`);
			expect(revokedCredsResponse.status).toBe(401);

			// 12. Idempotent revoke returns 200
			const replayRevokeResponse = await request(app).post('/oauth/revoke').type('form').send({
				client_id: clientId,
				client_secret: clientSecret,
				token: accessToken2,
			});
			expect(replayRevokeResponse.status).toBe(200);
			expect(replayRevokeResponse.body).toEqual({});
		});
	});
});
