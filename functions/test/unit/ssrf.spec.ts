import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { assertSafeUrl, UnsafeUrlError } from '../../src/security/ssrf.js';

describe('assertSafeUrl', () => {
	describe('in local development (NODE_ENV=test)', () => {
		test('allows a public https URL', async () => {
			const url = await assertSafeUrl('https://8.8.8.8/foo');
			expect(url.toString()).toBe('https://8.8.8.8/foo');
		});

		test('allows http and loopback for emulator/test convenience', async () => {
			await expect(assertSafeUrl('http://127.0.0.1:5001/foo')).resolves.toBeInstanceOf(URL);
			await expect(assertSafeUrl('http://localhost:5001/foo')).resolves.toBeInstanceOf(URL);
		});

		test('still rejects private and link-local ranges', async () => {
			await expect(assertSafeUrl('http://192.168.1.1/foo')).rejects.toThrow(UnsafeUrlError);
			await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
				UnsafeUrlError,
			);
			await expect(assertSafeUrl('http://10.0.0.1/foo')).rejects.toThrow(UnsafeUrlError);
		});

		test('rejects an invalid URL', async () => {
			await expect(assertSafeUrl('not-a-url')).rejects.toThrow(UnsafeUrlError);
		});
	});

	describe('in production-like environment', () => {
		let originalNodeEnv: string | undefined;
		let originalEmulator: string | undefined;

		beforeEach(() => {
			originalNodeEnv = process.env.NODE_ENV;
			originalEmulator = process.env.FUNCTIONS_EMULATOR;
			process.env.NODE_ENV = 'production';
			delete process.env.FUNCTIONS_EMULATOR;
		});

		afterEach(() => {
			process.env.NODE_ENV = originalNodeEnv;
			if (originalEmulator === undefined) {
				delete process.env.FUNCTIONS_EMULATOR;
			} else {
				process.env.FUNCTIONS_EMULATOR = originalEmulator;
			}
		});

		test('allows a public https URL', async () => {
			await expect(assertSafeUrl('https://8.8.8.8/foo')).resolves.toBeInstanceOf(URL);
		});

		test('rejects http even to a public address', async () => {
			await expect(assertSafeUrl('http://8.8.8.8/foo')).rejects.toThrow(UnsafeUrlError);
		});

		test('rejects loopback (127.0.0.0/8)', async () => {
			await expect(assertSafeUrl('https://127.0.0.1/foo')).rejects.toThrow(UnsafeUrlError);
		});

		test('rejects IPv6 loopback (::1)', async () => {
			await expect(assertSafeUrl('https://[::1]/foo')).rejects.toThrow(UnsafeUrlError);
		});

		test('rejects private ranges (RFC1918)', async () => {
			await expect(assertSafeUrl('https://10.0.0.1/foo')).rejects.toThrow(UnsafeUrlError);
			await expect(assertSafeUrl('https://172.16.0.1/foo')).rejects.toThrow(UnsafeUrlError);
			await expect(assertSafeUrl('https://192.168.0.1/foo')).rejects.toThrow(UnsafeUrlError);
		});

		test('rejects link-local range including the cloud metadata server', async () => {
			await expect(assertSafeUrl('https://169.254.169.254/latest/meta-data')).rejects.toThrow(
				UnsafeUrlError,
			);
		});
	});
});
