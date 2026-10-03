import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import oauthRouter, {
	firebaseWebappsResponseSchema,
	firebaseWebappConfigSchema,
	oauthAuthorizeQuerySchema,
	oauthAuthorizeBodySchema,
	oauthTokenBodySchema,
} from '../../src/mastodon/oauth.js';

describe('oauth schemas', () => {
	describe('firebaseWebappsResponseSchema', () => {
		test('parses response with apps array', () => {
			const result = firebaseWebappsResponseSchema.safeParse({
				apps: [{ appId: 'app-1' }, { appId: 'app-2' }],
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.apps).toEqual([{ appId: 'app-1' }, { appId: 'app-2' }]);
			}
		});

		test('defaults to empty array when apps is omitted', () => {
			const result = firebaseWebappsResponseSchema.safeParse({});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.apps).toEqual([]);
			}
		});

		test('rejects malformed response', () => {
			expect(firebaseWebappsResponseSchema.safeParse({ apps: 'not-an-array' }).success).toBe(false);
			expect(
				firebaseWebappsResponseSchema.safeParse({ apps: [{ missingAppId: 123 }] }).success,
			).toBe(false);
			expect(firebaseWebappsResponseSchema.safeParse(null).success).toBe(false);
		});
	});

	describe('firebaseWebappConfigSchema', () => {
		test('parses config object', () => {
			const config = {
				apiKey: 'AIzaSy...',
				appId: '1:12345:web:67890',
				projectId: 'my-project',
			};
			const result = firebaseWebappConfigSchema.safeParse(config);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual(config);
			}
		});

		test('rejects non-object configs', () => {
			expect(firebaseWebappConfigSchema.safeParse('string').success).toBe(false);
			expect(firebaseWebappConfigSchema.safeParse(123).success).toBe(false);
			expect(firebaseWebappConfigSchema.safeParse(null).success).toBe(false);
		});
	});

	describe('oauthAuthorizeQuerySchema', () => {
		test('parses valid query parameters with default scope', () => {
			const result = oauthAuthorizeQuerySchema.safeParse({
				client_id: 'client-1',
				redirect_uri: 'https://example.com/callback',
				response_type: 'code',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual({
					client_id: 'client-1',
					redirect_uri: 'https://example.com/callback',
					response_type: 'code',
					scope: 'scope',
				});
			}
		});

		test('rejects missing client_id', () => {
			const result = oauthAuthorizeQuerySchema.safeParse({
				redirect_uri: 'https://example.com/callback',
				response_type: 'code',
			});
			expect(result.success).toBe(false);
		});

		test('rejects empty strings', () => {
			const result = oauthAuthorizeQuerySchema.safeParse({
				client_id: '',
				redirect_uri: 'https://example.com/callback',
				response_type: 'code',
			});
			expect(result.success).toBe(false);
		});
	});

	describe('oauthAuthorizeBodySchema', () => {
		test('parses valid idToken', () => {
			const result = oauthAuthorizeBodySchema.safeParse({ idToken: 'valid.jwt.token' });
			expect(result.success).toBe(true);
		});

		test('rejects missing or empty idToken', () => {
			expect(oauthAuthorizeBodySchema.safeParse({}).success).toBe(false);
			expect(oauthAuthorizeBodySchema.safeParse({ idToken: '' }).success).toBe(false);
		});
	});

	describe('oauthTokenBodySchema', () => {
		test('parses body with grant_type and preserves other parameters', () => {
			const payload = {
				grant_type: 'authorization_code',
				code: 'auth-code-123',
				redirect_uri: 'https://example.com/callback',
				client_id: 'client-id',
			};
			const result = oauthTokenBodySchema.safeParse(payload);
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual(payload);
			}
		});

		test('rejects body missing grant_type', () => {
			const result = oauthTokenBodySchema.safeParse({
				client_id: 'client-id',
			});
			expect(result.success).toBe(false);
		});
	});
});

describe('oauth CORS', () => {
	const withServer = async (fn: (base: string) => Promise<void>) => {
		const app = express();
		app.use(express.json());
		app.use(express.urlencoded({ extended: true }));
		app.use('/oauth', oauthRouter);
		const server = app.listen(0);
		try {
			await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
		} finally {
			server.close();
		}
	};

	test('token preflight allows cross-origin requests', async () => {
		await withServer(async (base) => {
			const res = await fetch(`${base}/oauth/token`, {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://phanpy.social',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'content-type',
				},
			});
			expect(res.status).toBe(204);
			expect(res.headers.get('access-control-allow-origin')).toBe('https://phanpy.social');
			expect(res.headers.get('access-control-allow-methods')).toContain('POST');
		});
	});

	test('token response carries Access-Control-Allow-Origin even on errors', async () => {
		await withServer(async (base) => {
			const res = await fetch(`${base}/oauth/token`, {
				method: 'POST',
				headers: { Origin: 'https://phanpy.social', 'Content-Type': 'application/json' },
				body: '{}',
			});
			expect(res.status).toBe(400);
			expect(res.headers.get('access-control-allow-origin')).toBe('https://phanpy.social');
		});
	});
});
