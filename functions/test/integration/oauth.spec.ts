import express from 'express';
import request from 'supertest';
import {describe, expect, test, afterEach, beforeEach} from 'vitest';
import oauthRouter from '../../src/mastodon/oauth.js';
import {Clients, Users} from '../../src/mastodon/oauth2Model.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

// mastodonApi (src/mastodon/index.ts) 自体は body-parser を持たず、本番では
// Cloud Functions Framework が req.body を解決してから oauthRouter に渡す。
// この前提を supertest から再現するため、ここでは同じミドルウェアを自前で挟む。
const app = express();
app.use(express.json());
app.use(express.urlencoded({extended: true}));
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
			await Users.add({id: 'user-1', username: 'hakatashi', password: 'hunter2'});
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
			const response = await request(app)
				.post('/oauth/token')
				.type('form')
				.send({
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
			const response = await request(app)
				.post('/oauth/token')
				.type('form')
				.send({
					grant_type: 'client_credentials',
					client_id: 'unknown-client',
					client_secret: 'wrong-secret',
				});

			expect(response.status).toBe(400);
		});

		test('accepts a JSON body as a workaround for clients that send the wrong content type', async () => {
			// https://github.com/elk-zone/elk/issues/2244
			const response = await request(app)
				.post('/oauth/token')
				.send({
					grant_type: 'client_credentials',
					client_id: 'client-id',
					client_secret: 'client-secret',
					scope: 'read',
				});

			expect(response.status).toBe(200);
			expect(response.body.access_token).toEqual(expect.any(String));
		});
	});

	describe('POST /oauth/revoke', () => {
		test('is not implemented yet', async () => {
			const response = await request(app).post('/oauth/revoke');
			expect(response.status).toBe(501);
		});
	});
});
