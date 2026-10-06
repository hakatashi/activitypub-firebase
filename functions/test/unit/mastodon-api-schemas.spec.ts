import { describe, expect, test } from 'vitest';
import {
	accountLookupQuerySchema,
	accountParamsSchema,
	relationshipsQuerySchema,
	updateCredentialsBodySchema,
} from '../../src/mastodon/routes/accounts.js';
import { createAppBodySchema } from '../../src/mastodon/routes/apps.js';

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

	describe('relationshipsQuerySchema', () => {
		test('parses single id string into array', () => {
			const result = relationshipsQuerySchema.safeParse({ id: '123' });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.id).toEqual(['123']);
			}
		});

		test('parses array of ids', () => {
			const result = relationshipsQuerySchema.safeParse({ id: ['123', '456'] });
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.id).toEqual(['123', '456']);
			}
		});

		test('rejects missing id', () => {
			expect(relationshipsQuerySchema.safeParse({}).success).toBe(false);
		});
	});

	describe('updateCredentialsBodySchema', () => {
		test('parses valid credentials update', () => {
			const result = updateCredentialsBodySchema.safeParse({
				display_name: 'New Name',
				note: 'New bio',
				locked: 'true',
				bot: false,
				fields_attributes: [{ name: 'Website', value: 'https://example.com' }],
				source: {
					privacy: 'unlisted',
					sensitive: 'true',
					language: 'ja',
				},
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.display_name).toBe('New Name');
				expect(result.data.note).toBe('New bio');
				expect(result.data.locked).toBe(true);
				expect(result.data.bot).toBe(false);
				expect(result.data.source?.privacy).toBe('unlisted');
				expect(result.data.source?.sensitive).toBe(true);
			}
		});

		test('parses object-style fields_attributes', () => {
			const result = updateCredentialsBodySchema.safeParse({
				fields_attributes: {
					'0': { name: 'Pronouns', value: 'they/them' },
				},
			});
			expect(result.success).toBe(true);
		});
	});
});
