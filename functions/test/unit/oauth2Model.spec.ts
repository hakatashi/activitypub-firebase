import type {AuthorizationCode, Client, Token, User} from '@node-oauth/oauth2-server';
import {describe, expect, test, afterEach, beforeEach} from 'vitest';
import {Clients, Oauth2Model, RefreshTokens, Users} from '../../src/mastodon/oauth2Model.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

describe('Oauth2Model', () => {
	const model = new Oauth2Model();

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

	describe('getClient', () => {
		test('finds a client by clientId and clientSecret', async () => {
			await Clients.add({
				id: '1',
				name: 'test client',
				redirectUris: 'https://example.com/callback',
				grants: ['authorization_code'],
				clientId: 'client-id',
				clientSecret: 'client-secret',
				scopes: ['read'],
				vapidKey: 'vapid-key',
			});

			const client = await model.getClient('client-id', 'client-secret');
			expect(client).toMatchObject({clientId: 'client-id', clientSecret: 'client-secret'});
		});

		test('ignores clientSecret when it is null', async () => {
			await Clients.add({
				id: '1',
				name: 'test client',
				redirectUris: 'https://example.com/callback',
				grants: ['authorization_code'],
				clientId: 'client-id',
				clientSecret: 'client-secret',
				scopes: ['read'],
				vapidKey: 'vapid-key',
			});

			const client = await model.getClient('client-id', null);
			expect(client).toMatchObject({clientId: 'client-id'});
		});

		test('returns false when the client does not exist', async () => {
			expect(await model.getClient('missing-client-id', null)).toBe(false);
		});

		test('returns false when the secret does not match', async () => {
			await Clients.add({
				id: '1',
				name: 'test client',
				redirectUris: 'https://example.com/callback',
				grants: ['authorization_code'],
				clientId: 'client-id',
				clientSecret: 'client-secret',
				scopes: ['read'],
				vapidKey: 'vapid-key',
			});

			expect(await model.getClient('client-id', 'wrong-secret')).toBe(false);
		});
	});

	describe('saveToken / getAccessToken', () => {
		const client = {id: 'client-1', grants: ['authorization_code']} as Client;
		const user = {id: 'user-1'} as User;

		test('round-trips a token, converting Firestore Timestamps back to Date', async () => {
			const token = {
				accessToken: 'access-token',
				accessTokenExpiresAt: new Date('2023-01-01T00:00:00.000Z'),
				refreshToken: 'refresh-token',
				refreshTokenExpiresAt: new Date('2023-02-01T00:00:00.000Z'),
				scope: 'read',
			} as unknown as Token;

			const saved = await model.saveToken(token, client, user);
			expect(saved).not.toBe(false);

			const fetched = await model.getAccessToken('access-token');
			expect(fetched).not.toBe(false);
			expect((fetched as Token).accessToken).toBe('access-token');
			expect((fetched as Token).accessTokenExpiresAt).toEqual(new Date('2023-01-01T00:00:00.000Z'));
			expect((fetched as Token).refreshTokenExpiresAt).toEqual(new Date('2023-02-01T00:00:00.000Z'));
			expect((fetched as Token).client).toEqual(client);
			expect((fetched as Token).user).toEqual(user);
		});

		test('does not save a refresh token when the token has none', async () => {
			const token = {
				accessToken: 'access-only-token',
				accessTokenExpiresAt: new Date('2023-01-01T00:00:00.000Z'),
				refreshTokenExpiresAt: new Date('2023-02-01T00:00:00.000Z'),
				scope: 'read',
			} as unknown as Token;

			await model.saveToken(token, client, user);

			expect((await RefreshTokens.get()).empty).toBe(true);
		});

		test('returns false for a non-existent access token', async () => {
			expect(await model.getAccessToken('missing-token')).toBe(false);
		});
	});

	describe('saveAuthorizationCode / getAuthorizationCode / revokeAuthorizationCode', () => {
		const client = {id: 'client-1', grants: ['authorization_code']} as Client;
		const user = {id: 'user-1'} as User;

		test('round-trips an authorization code, converting expiresAt back to a Date', async () => {
			const code = {
				authorizationCode: 'auth-code',
				expiresAt: new Date('2023-01-01T00:00:00.000Z'),
				redirectUri: 'https://example.com/callback',
				scope: 'read',
			} as unknown as AuthorizationCode;

			const saved = await model.saveAuthorizationCode(code, client, user);
			expect(saved).not.toBe(false);

			const fetched = await model.getAuthorizationCode('auth-code');
			expect(fetched).not.toBe(false);
			expect((fetched as AuthorizationCode).authorizationCode).toBe('auth-code');
			expect((fetched as AuthorizationCode).expiresAt).toEqual(new Date('2023-01-01T00:00:00.000Z'));
			expect((fetched as AuthorizationCode).client).toEqual(client);
			expect((fetched as AuthorizationCode).user).toEqual(user);
		});

		test('returns false for a non-existent authorization code', async () => {
			expect(await model.getAuthorizationCode('missing-code')).toBe(false);
		});

		test('revokes an existing code once, then reports it as already gone', async () => {
			const code = {
				authorizationCode: 'revocable-code',
				expiresAt: new Date('2023-01-01T00:00:00.000Z'),
				redirectUri: 'https://example.com/callback',
				scope: 'read',
			} as unknown as AuthorizationCode;
			await model.saveAuthorizationCode(code, client, user);

			expect(await model.revokeAuthorizationCode(code)).toBe(true);
			expect(await model.getAuthorizationCode('revocable-code')).toBe(false);
			expect(await model.revokeAuthorizationCode(code)).toBe(false);
		});
	});

	describe('getUserFromClient', () => {
		test('finds the user referenced by client.userId', async () => {
			await Users.add({id: 'user-1', username: 'hakatashi', password: 'hunter2'});

			const user = await model.getUserFromClient({userId: 'user-1'} as Client);
			expect(user).toMatchObject({id: 'user-1', username: 'hakatashi'});
		});

		test('returns false when no user matches', async () => {
			expect(await model.getUserFromClient({userId: 'missing-user'} as Client)).toBe(false);
		});
	});

	describe('getUser', () => {
		test('finds a user by matching username and password', async () => {
			await Users.add({id: 'user-1', username: 'hakatashi', password: 'hunter2'});

			const user = await model.getUser('hakatashi', 'hunter2');
			expect(user).toMatchObject({id: 'user-1', username: 'hakatashi'});
		});

		test('returns false when the password does not match', async () => {
			await Users.add({id: 'user-1', username: 'hakatashi', password: 'hunter2'});

			expect(await model.getUser('hakatashi', 'wrong-password')).toBe(false);
		});
	});

	describe('verifyScope', () => {
		test('returns true when all requested scopes are authorized (string form)', async () => {
			const token = {scope: 'read write'} as unknown as Token;
			expect(await model.verifyScope(token, 'read')).toBe(true);
		});

		test('returns true when all requested scopes are authorized (array form)', async () => {
			const token = {scope: ['read', 'write']} as unknown as Token;
			expect(await model.verifyScope(token, ['read', 'write'])).toBe(true);
		});

		test('returns false when a requested scope is missing', async () => {
			const token = {scope: 'read'} as unknown as Token;
			expect(await model.verifyScope(token, ['read', 'write'])).toBe(false);
		});

		test('returns false when the token has no scope', async () => {
			const token = {} as unknown as Token;
			expect(await model.verifyScope(token, 'read')).toBe(false);
		});
	});

	test('revokeAuthorizationCode returns false for a code that was never saved', async () => {
		const code = {authorizationCode: 'never-existed'} as AuthorizationCode;
		expect(await model.revokeAuthorizationCode(code)).toBe(false);
	});
});
