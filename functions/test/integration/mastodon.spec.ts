import firebase from 'firebase-admin';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/activitypub.js';
import { domain, escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { AccessTokens, UserInfos } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const UID_ME = 'uid-hakatashi';

describe('mastodon', () => {
	const addToken = async (token: string, scope: string, uid = UID_ME) => {
		const farFuture = firebase.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
		await AccessTokens.add({
			accessToken: token,
			accessTokenExpiresAt: farFuture,
			refreshTokenExpiresAt: farFuture,
			scope,
			client: { id: '1', grants: [] },
			user: { userId: uid },
		} as never);
	};

	beforeEach(() => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
	});

	// Teardown firestore database after each test
	afterEach(async () => {
		vi.restoreAllMocks();
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

	test('Unknown route falls back to 404 with JSON error', async () => {
		const response = await request(mastodon).get('/api/v1/unknown_route');
		expect(response.status).toBe(404);
		expect(response.body.error).toBe('Record not found');
	});

	describe('/api', () => {
		describe('/api/v1/streaming', () => {
			test('returns 404 for streaming endpoint (ADR-0007)', async () => {
				const response = await request(mastodon).get('/api/v1/streaming');
				expect(response.status).toBe(404);
				expect(response.body.error).toBe('Record not found');
			});

			test('returns 404 for streaming subpath', async () => {
				const response = await request(mastodon).get('/api/v1/streaming/user');
				expect(response.status).toBe(404);
				expect(response.body.error).toBe('Record not found');
			});
		});

		describe('/api/v1/instance', () => {
			test('Returns instance information with empty streaming_api and stats', async () => {
				const response = await request(mastodon).get('/api/v1/instance');
				expect(response.status).toBe(200);
				expect(response.body.uri).toBe('mastodon-dev.hakatashi.com');
				expect(response.body.title).toBe('HakataFediverse');
				expect(response.body.version).toBe('4.3.0');
				expect(response.body.urls.streaming_api).toBe('');
				expect(response.body.stats.domain_count).toBeGreaterThanOrEqual(1);
			});

			test('Reflects user info when available', async () => {
				const actorKey = escapeFirestoreKey(`https://${domain}/activitypub/u/hakatashi`);
				await UserInfos.doc(actorKey).set({
					id: '1',
					uid: UID_ME,
					locked: false,
					bot: false,
					created_at: '2026-01-01T00:00:00.000Z',
					followers_count: 42,
					following_count: 10,
					statuses_count: 100,
					last_status_at: '2026-10-04T00:00:00.000Z',
					emojis: [],
					fields: [],
					roles: [],
				});

				const response = await request(mastodon).get('/api/v1/instance');
				expect(response.status).toBe(200);
				expect(response.body.contact_account.followers_count).toBe(42);
				expect(response.body.contact_account.following_count).toBe(10);
				expect(response.body.contact_account.statuses_count).toBe(100);
				expect(response.body.contact_account.last_status_at).toBe('2026-10-04T00:00:00.000Z');
				expect(response.body.stats.status_count).toBe(100);
			});
		});

		describe('/api/v2/instance', () => {
			test('Returns instance information with 4.3.0 version and api_versions', async () => {
				const response = await request(mastodon).get('/api/v2/instance');
				expect(response.status).toBe(200);
				expect(response.body.domain).toBe('mastodon-dev.hakatashi.com');
				expect(response.body.title).toBe('HakataFediverse');
				expect(response.body.version).toBe('4.3.0');
				expect(response.body.api_versions).toEqual({ mastodon: 1 });
				expect(response.body.configuration.urls.streaming).toBe('');
				expect(response.body.configuration.statuses.max_characters).toBe(500);
				expect(response.body.thumbnail.url).toContain('githubusercontent.com');
				expect(response.body.contact.account.url).toContain('elk.zone');
			});

			test('Reflects user info when available', async () => {
				const actorKey = escapeFirestoreKey(`https://${domain}/activitypub/u/hakatashi`);
				await UserInfos.doc(actorKey).set({
					id: '1',
					uid: UID_ME,
					locked: false,
					bot: false,
					created_at: '2026-01-01T00:00:00.000Z',
					followers_count: 42,
					following_count: 10,
					statuses_count: 100,
					last_status_at: '2026-10-04T00:00:00.000Z',
					emojis: [],
					fields: [],
					roles: [],
				});

				const response = await request(mastodon).get('/api/v2/instance');
				expect(response.status).toBe(200);
				expect(response.body.contact.account.followers_count).toBe(42);
				expect(response.body.contact.account.following_count).toBe(10);
				expect(response.body.contact.account.statuses_count).toBe(100);
				expect(response.body.contact.account.last_status_at).toBe('2026-10-04T00:00:00.000Z');
			});
		});

		describe('Empty array stubs (ADR-0004, ADR-0067)', () => {
			test('/api/v1/custom_emojis returns empty array without auth', async () => {
				const response = await request(mastodon).get('/api/v1/custom_emojis');
				expect(response.status).toBe(200);
				expect(response.body).toEqual([]);
			});

			test('/api/v1/accounts/:id/featured_tags returns empty array without auth', async () => {
				const response = await request(mastodon).get('/api/v1/accounts/1/featured_tags');
				expect(response.status).toBe(200);
				expect(response.body).toEqual([]);
			});

			describe('Authenticated empty array stubs', () => {
				beforeEach(async () => {
					const me = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
					await apex.store.saveObject(me);
					await UserInfos.doc(escapeFirestoreKey(me.id)).set({
						id: '1',
						uid: UID_ME,
						locked: false,
						bot: false,
						created_at: '2026-01-01T00:00:00.000Z',
						followers_count: 0,
						following_count: 0,
						statuses_count: 0,
						last_status_at: '',
						emojis: [],
						fields: [],
						roles: [],
					});
					await addToken('test-token', 'read write follow');
				});

				const endpoints = [
					'/api/v1/filters',
					'/api/v2/filters',
					'/api/v1/announcements',
					'/api/v1/lists',
					'/api/v1/followed_tags',
					'/api/v1/conversations',
					'/api/v1/blocks',
					'/api/v1/mutes',
					'/api/v1/domain_blocks',
					'/api/v1/bookmarks',
					'/api/v1/favourites',
					'/api/v1/follow_requests',
					'/api/v1/featured_tags',
				];

				for (const endpoint of endpoints) {
					test(`${endpoint} returns empty array when authenticated`, async () => {
						const response = await request(mastodon)
							.get(endpoint)
							.set('Authorization', 'Bearer test-token');
						expect(response.status).toBe(200);
						expect(response.body).toEqual([]);
					});

					test(`${endpoint} returns 401 when unauthorized`, async () => {
						const response = await request(mastodon).get(endpoint);
						expect(response.status).toBe(401);
					});
				}
			});
		});

		describe('/api/v1/markers', () => {
			beforeEach(async () => {
				const me = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
				await apex.store.saveObject(me);
				await UserInfos.doc(escapeFirestoreKey(me.id)).set({
					id: '1',
					uid: UID_ME,
					locked: false,
					bot: false,
					created_at: '2026-01-01T00:00:00.000Z',
					followers_count: 0,
					following_count: 0,
					statuses_count: 0,
					last_status_at: '',
					emojis: [],
					fields: [],
					roles: [],
				});
				await addToken('test-token', 'read write follow');
			});

			test('returns 401 when unauthorized', async () => {
				const response = await request(mastodon).get('/api/v1/markers');
				expect(response.status).toBe(401);
			});

			test('returns empty object when no timeline specified', async () => {
				const response = await request(mastodon)
					.get('/api/v1/markers')
					.set('Authorization', 'Bearer test-token');
				expect(response.status).toBe(200);
				expect(response.body).toEqual({});
			});

			test('saves and retrieves markers with version increment', async () => {
				// Create home and notifications marker
				const postRes1 = await request(mastodon)
					.post('/api/v1/markers')
					.set('Authorization', 'Bearer test-token')
					.send({
						home: { last_read_id: '100' },
						notifications: { last_read_id: '200' },
					});
				expect(postRes1.status).toBe(200);
				expect(postRes1.body.home).toMatchObject({
					last_read_id: '100',
					version: 1,
				});
				expect(postRes1.body.home.updated_at).toEqual(expect.any(String));
				expect(postRes1.body.notifications).toMatchObject({
					last_read_id: '200',
					version: 1,
				});

				// Update home marker
				const postRes2 = await request(mastodon)
					.post('/api/v1/markers')
					.set('Authorization', 'Bearer test-token')
					.send({
						home: { last_read_id: '105' },
					});
				expect(postRes2.status).toBe(200);
				expect(postRes2.body.home).toMatchObject({
					last_read_id: '105',
					version: 2,
				});

				// GET markers
				const getRes = await request(mastodon)
					.get('/api/v1/markers')
					.query({ timeline: ['home', 'notifications'] })
					.set('Authorization', 'Bearer test-token');
				expect(getRes.status).toBe(200);
				expect(getRes.body.home).toMatchObject({
					last_read_id: '105',
					version: 2,
				});
				expect(getRes.body.notifications).toMatchObject({
					last_read_id: '200',
					version: 1,
				});
			});

			test('returns 409 conflict when version does not match', async () => {
				await request(mastodon)
					.post('/api/v1/markers')
					.set('Authorization', 'Bearer test-token')
					.send({
						home: { last_read_id: '100' },
					});

				// Attempt to update with mismatched version
				const conflictRes = await request(mastodon)
					.post('/api/v1/markers')
					.set('Authorization', 'Bearer test-token')
					.send({
						home: { last_read_id: '105', version: 99 },
					});
				expect(conflictRes.status).toBe(409);
				expect(conflictRes.body.error).toBe('Conflict during update, please try again');
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
				expect(response.body.redirect_uris).toEqual(['urn:ietf:wg:oauth:2.0:oob']);
				expect(response.body.client_id).toEqual(expect.any(String));
				expect(response.body.client_secret).toEqual(expect.any(String));
				expect(response.body.client_secret_expires_at).toBe(0);
			});

			test('creates a new app with array redirect_uris', async () => {
				const response = await request(mastodon)
					.post('/api/v1/apps')
					.send({
						client_name: 'Test App Array',
						redirect_uris: ['https://example.com/oauth', 'https://example.com/oauth2'],
						scopes: 'read write',
					});
				expect(response.status).toBe(200);
				expect(response.body.name).toBe('Test App Array');
				expect(response.body.redirect_uris).toEqual([
					'https://example.com/oauth',
					'https://example.com/oauth2',
				]);
				expect(response.body.redirect_uri).toBe(
					'https://example.com/oauth\nhttps://example.com/oauth2',
				);
				expect(response.body.client_secret_expires_at).toBe(0);
			});

			test('concurrent app creation generates distinct IDs', async () => {
				const [res1, res2] = await Promise.all([
					request(mastodon).post('/api/v1/apps').send({
						client_name: 'Concurrent App 1',
						redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
					}),
					request(mastodon).post('/api/v1/apps').send({
						client_name: 'Concurrent App 2',
						redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
					}),
				]);
				expect(res1.status).toBe(200);
				expect(res2.status).toBe(200);
				expect(res1.body.id).not.toBe(res2.body.id);
			});
		});

		describe('/api/v1/apps/verify_credentials', () => {
			test('returns 401 when no token is provided', async () => {
				const response = await request(mastodon).get('/api/v1/apps/verify_credentials');
				expect(response.status).toBe(401);
			});

			test('returns 401 when invalid token is provided', async () => {
				const response = await request(mastodon)
					.get('/api/v1/apps/verify_credentials')
					.set('Authorization', 'Bearer invalid-token');
				expect(response.status).toBe(401);
			});

			test('returns app credentials without client secrets when authorized', async () => {
				const appResponse = await request(mastodon)
					.post('/api/v1/apps')
					.send({
						client_name: 'Verify App',
						redirect_uris: ['https://example.com/callback'],
						scopes: 'read write',
						website: 'https://example.com',
					});
				expect(appResponse.status).toBe(200);

				await addToken('test-app-token', 'read write');
				const tokenDocs = await AccessTokens.where('accessToken', '==', 'test-app-token').get();
				const tokenDoc = tokenDocs.docs[0];
				expect(tokenDoc).toBeDefined();
				await tokenDoc!.ref.update({
					client: {
						id: appResponse.body.id,
						clientId: appResponse.body.client_id,
						name: 'Verify App',
						redirectUris: ['https://example.com/callback'],
						scopes: ['read', 'write'],
						vapidKey: appResponse.body.vapid_key,
						website: 'https://example.com',
					},
				});

				const response = await request(mastodon)
					.get('/api/v1/apps/verify_credentials')
					.set('Authorization', 'Bearer test-app-token');

				expect(response.status).toBe(200);
				expect(response.body).toEqual({
					id: appResponse.body.id,
					name: 'Verify App',
					website: 'https://example.com',
					scopes: ['read', 'write'],
					redirect_uri: 'https://example.com/callback',
					redirect_uris: ['https://example.com/callback'],
					vapid_key: appResponse.body.vapid_key,
				});
				expect(response.body.client_id).toBeUndefined();
				expect(response.body.client_secret).toBeUndefined();
			});
		});

		describe('Authentication (authRequired) (Issue #157, ADR-0074)', () => {
			test('returns 401 with JSON error when no authorization header is provided', async () => {
				const resVerify = await request(mastodon).get('/api/v1/accounts/verify_credentials');
				expect(resVerify.status).toBe(401);
				expect(resVerify.body).toEqual({
					error: 'Unauthorized request: no authentication given',
				});

				const resTimeline = await request(mastodon).get('/api/v1/timelines/home');
				expect(resTimeline.status).toBe(401);
				expect(resTimeline.body).toEqual({
					error: 'Unauthorized request: no authentication given',
				});

				const resPrefs = await request(mastodon).get('/api/v1/preferences');
				expect(resPrefs.status).toBe(401);
				expect(resPrefs.body).toEqual({
					error: 'Unauthorized request: no authentication given',
				});

				const resPost = await request(mastodon).post('/api/v1/statuses').send({ status: 'hello' });
				expect(resPost.status).toBe(401);
				expect(resPost.body).toEqual({
					error: 'Unauthorized request: no authentication given',
				});
			});

			test('returns 401 with WWW-Authenticate header when invalid token is provided', async () => {
				const resVerify = await request(mastodon)
					.get('/api/v1/accounts/verify_credentials')
					.set('Authorization', 'Bearer invalid-token');
				expect(resVerify.status).toBe(401);
				expect(resVerify.body).toEqual({
					error: 'Invalid token: access token is invalid',
				});
				expect(resVerify.headers['www-authenticate']).toContain('invalid_token');

				const resTimeline = await request(mastodon)
					.get('/api/v1/timelines/home')
					.set('Authorization', 'Bearer invalid-token');
				expect(resTimeline.status).toBe(401);
				expect(resTimeline.body).toEqual({
					error: 'Invalid token: access token is invalid',
				});
				expect(resTimeline.headers['www-authenticate']).toContain('invalid_token');
			});

			test('returns 401 with WWW-Authenticate header when expired token is provided', async () => {
				const past = firebase.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
				await AccessTokens.add({
					accessToken: 'expired-token',
					accessTokenExpiresAt: past,
					refreshTokenExpiresAt: past,
					scope: 'read write',
					client: { id: '1', grants: [] },
					user: { userId: UID_ME },
				} as never);

				const res = await request(mastodon)
					.get('/api/v1/accounts/verify_credentials')
					.set('Authorization', 'Bearer expired-token');
				expect(res.status).toBe(401);
				expect(res.body).toEqual({
					error: 'Invalid token: access token has expired',
				});
				expect(res.headers['www-authenticate']).toContain('invalid_token');
			});

			test('returns 401 when token has non-existent user in UserInfos', async () => {
				await addToken('token-with-no-user', 'read write', 'non-existent-uid');

				const resVerify = await request(mastodon)
					.get('/api/v1/accounts/verify_credentials')
					.set('Authorization', 'Bearer token-with-no-user');
				expect(resVerify.status).toBe(401);
				expect(resVerify.body).toEqual({
					error: 'This method requires an authenticated user',
				});

				const resTimeline = await request(mastodon)
					.get('/api/v1/timelines/home')
					.set('Authorization', 'Bearer token-with-no-user');
				expect(resTimeline.status).toBe(401);
				expect(resTimeline.body).toEqual({
					error: 'This method requires an authenticated user',
				});
			});

			test('returns 401 when token has no user context (e.g. client credentials token)', async () => {
				const farFuture = firebase.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
				await AccessTokens.add({
					accessToken: 'client-credentials-token',
					accessTokenExpiresAt: farFuture,
					refreshTokenExpiresAt: farFuture,
					scope: 'read write',
					client: { id: '1', grants: [] },
					user: null,
				} as never);

				const res = await request(mastodon)
					.get('/api/v1/accounts/verify_credentials')
					.set('Authorization', 'Bearer client-credentials-token');
				expect(res.status).toBe(401);
				expect(res.body).toEqual({
					error: 'This method requires an authenticated user',
				});
			});

			test('returns 401 with WWW-Authenticate header for apps/verify_credentials with invalid token', async () => {
				const res = await request(mastodon)
					.get('/api/v1/apps/verify_credentials')
					.set('Authorization', 'Bearer invalid-app-token');
				expect(res.status).toBe(401);
				expect(res.body).toEqual({
					error: 'Invalid token: access token is invalid',
				});
				expect(res.headers['www-authenticate']).toContain('invalid_token');
			});

			test('returns 500 JSON error when unexpected internal error occurs during authentication', async () => {
				await addToken('valid-token-for-error-test', 'read write');
				vi.spyOn(UserInfos, 'where').mockImplementationOnce(() => {
					throw new Error('Database connection failed');
				});

				const res = await request(mastodon)
					.get('/api/v1/accounts/verify_credentials')
					.set('Authorization', 'Bearer valid-token-for-error-test');
				expect(res.status).toBe(500);
				expect(res.body).toEqual({
					error: 'Internal server error',
				});
			});
		});
	});
});
