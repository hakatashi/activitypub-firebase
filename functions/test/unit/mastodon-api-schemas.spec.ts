import { describe, expect, test } from 'vitest';
import {
	accountLookupQuerySchema,
	accountParamsSchema,
	createAppBodySchema,
} from '../../src/mastodon/api.js';

describe('mastodon api schemas', () => {
	describe('accountLookupQuerySchema', () => {
		test('parses valid acct', () => {
			const result = accountLookupQuerySchema.safeParse({ acct: 'hakatashi' });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.acct).toBe('hakatashi');
			}
		});

		test('rejects empty or missing acct', () => {
			expect(accountLookupQuerySchema.safeParse({}).success).toBe(false);
			expect(accountLookupQuerySchema.safeParse({ acct: '' }).success).toBe(false);
		});
	});

	describe('accountParamsSchema', () => {
		test('parses valid id', () => {
			const result = accountParamsSchema.safeParse({ id: '1' });
			expect(result.success).toBe(true);
		});

		test('rejects missing or empty id', () => {
			expect(accountParamsSchema.safeParse({}).success).toBe(false);
			expect(accountParamsSchema.safeParse({ id: '' }).success).toBe(false);
		});
	});

	describe('createAppBodySchema', () => {
		test('parses valid payload with default scopes and website', () => {
			const result = createAppBodySchema.safeParse({
				client_name: 'My App',
				redirect_uris: 'https://example.com/oauth',
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data).toEqual({
					client_name: 'My App',
					redirect_uris: 'https://example.com/oauth',
					scopes: 'read',
					website: '',
				});
			}
		});

		test('parses multiple valid scopes', () => {
			const result = createAppBodySchema.safeParse({
				client_name: 'My App',
				redirect_uris: 'https://example.com/oauth',
				scopes: 'read write follow write:statuses',
			});
			expect(result.success).toBe(true);
		});

		test('rejects invalid scopes', () => {
			const result = createAppBodySchema.safeParse({
				client_name: 'My App',
				redirect_uris: 'https://example.com/oauth',
				scopes: 'read admin:all',
			});
			expect(result.success).toBe(false);
		});

		test('rejects missing client_name or redirect_uris', () => {
			expect(createAppBodySchema.safeParse({ redirect_uris: 'https://example.com' }).success).toBe(
				false,
			);
			expect(createAppBodySchema.safeParse({ client_name: 'My App' }).success).toBe(false);
		});
	});
});
