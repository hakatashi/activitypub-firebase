import { describe, expect, test, vi } from 'vitest';
import { assertSafeUrl, UnsafeUrlError } from '../../../src/apex/pub/ssrf.js';

const logger = { warn: vi.fn() };

describe('assertSafeUrl', () => {
	describe('with a permissive policy (local development)', () => {
		const policy = {
			allowedProtocols: ['https:', 'http:'],
			allowedRanges: ['unicast', 'loopback'],
		};

		test('allows http and loopback', async () => {
			const { url, addresses } = await assertSafeUrl('http://127.0.0.1:5001/foo', {
				policy,
				logger,
			});
			expect(url.toString()).toBe('http://127.0.0.1:5001/foo');
			expect(addresses).toEqual(['127.0.0.1']);
			await expect(
				assertSafeUrl('http://localhost:5001/foo', { policy, logger }),
			).resolves.toHaveProperty('url', expect.any(URL));
		});

		test('still rejects private and link-local ranges', async () => {
			for (const url of [
				'http://192.168.1.1/foo',
				'http://169.254.169.254/latest/meta-data',
				'http://10.0.0.1/foo',
			]) {
				await expect(assertSafeUrl(url, { policy, logger })).rejects.toThrow(UnsafeUrlError);
			}
		});
	});

	describe('with an injected resolver', () => {
		test('uses resolveAddresses instead of DNS', async () => {
			const resolveAddresses = vi.fn().mockResolvedValue(['8.8.8.8']);
			const { addresses } = await assertSafeUrl('https://example.test/foo', {
				policy: { resolveAddresses },
				logger,
			});
			expect(resolveAddresses).toHaveBeenCalledWith('example.test');
			expect(addresses).toEqual(['8.8.8.8']);
		});

		test('rejects when the resolver returns an internal address', async () => {
			const policy = { resolveAddresses: () => Promise.resolve(['10.0.0.5']) };
			await expect(assertSafeUrl('https://example.test/foo', { policy, logger })).rejects.toThrow(
				UnsafeUrlError,
			);
		});

		test('rejects when any of several addresses is internal', async () => {
			const policy = { resolveAddresses: () => Promise.resolve(['8.8.8.8', '127.0.0.1']) };
			await expect(assertSafeUrl('https://example.test/foo', { policy, logger })).rejects.toThrow(
				UnsafeUrlError,
			);
		});

		test('rejects an unresolvable hostname', async () => {
			const policy = { resolveAddresses: () => Promise.resolve([]) };
			await expect(assertSafeUrl('https://example.test/foo', { policy, logger })).rejects.toThrow(
				/Could not resolve/,
			);
		});

		test('evaluates a policy function on every call', async () => {
			const policy = vi.fn().mockReturnValue({});
			await assertSafeUrl('https://8.8.8.8/foo', { policy, logger });
			await assertSafeUrl('https://8.8.8.8/foo', { policy, logger });
			expect(policy).toHaveBeenCalledTimes(2);
		});
	});

	describe('with the default (strict) policy', () => {
		test('allows a public https URL', async () => {
			await expect(assertSafeUrl('https://8.8.8.8/foo', { logger })).resolves.toHaveProperty(
				'url',
				expect.any(URL),
			);
		});

		test('rejects http even to a public address', async () => {
			await expect(assertSafeUrl('http://8.8.8.8/foo', { logger })).rejects.toThrow(UnsafeUrlError);
		});

		test('rejects loopback (127.0.0.0/8)', async () => {
			await expect(assertSafeUrl('https://127.0.0.1/foo', { logger })).rejects.toThrow(
				UnsafeUrlError,
			);
		});

		test('rejects IPv6 loopback (::1)', async () => {
			await expect(assertSafeUrl('https://[::1]/foo', { logger })).rejects.toThrow(UnsafeUrlError);
		});

		test('rejects private ranges (RFC1918)', async () => {
			await expect(assertSafeUrl('https://10.0.0.1/foo', { logger })).rejects.toThrow(
				UnsafeUrlError,
			);
			await expect(assertSafeUrl('https://172.16.0.1/foo', { logger })).rejects.toThrow(
				UnsafeUrlError,
			);
			await expect(assertSafeUrl('https://192.168.0.1/foo', { logger })).rejects.toThrow(
				UnsafeUrlError,
			);
		});

		test('rejects link-local range including the cloud metadata server', async () => {
			await expect(
				assertSafeUrl('https://169.254.169.254/latest/meta-data', { logger }),
			).rejects.toThrow(UnsafeUrlError);
		});
	});
});
