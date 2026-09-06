import { describe, expect, test } from 'vitest';
import { z } from 'zod';

const firebaseWebappsResponseSchema = z.object({
	apps: z
		.array(z.object({ appId: z.string() }))
		.optional()
		.default([]),
});

const firebaseWebappConfigSchema = z.record(z.string(), z.unknown());

const oauthAuthorizeQuerySchema = z.object({
	client_id: z.string().min(1),
	redirect_uri: z.string().min(1),
	response_type: z.string().min(1),
	scope: z.string().default('scope'),
});

const oauthAuthorizeBodySchema = z.object({
	idToken: z.string().min(1),
});

const oauthTokenBodySchema = z
	.object({
		grant_type: z.string().min(1),
	})
	.passthrough();

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
