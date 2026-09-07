import type { Apex, APObject } from 'activitypub-express';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { safeRequestObject } from '../../src/security/safeRequestObject.js';
import { UnsafeUrlError } from '../../src/security/ssrf.js';

const PUBLIC_IP = '93.184.216.34';

const makeApex = (overrides: Partial<Apex> = {}) =>
	({
		makeUserAgentString: () => 'activitypub-firebase-test/1.0',
		requestTimeout: 5000,
		fromJSONLD: (obj: unknown) => Promise.resolve(obj as APObject),
		systemUser: undefined,
		...overrides,
	}) as unknown as Apex;

describe('safeRequestObject', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('fetches and normalizes a public object', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: `https://${PUBLIC_IP}/o/1`, type: 'Note' }), {
				status: 200,
				headers: { 'content-type': 'application/activity+json' },
			}),
		);

		const apex = makeApex();
		const result = await safeRequestObject.call(apex, `https://${PUBLIC_IP}/o/1`);

		expect(result).toEqual({ id: `https://${PUBLIC_IP}/o/1`, type: 'Note' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		expect((init.headers as Record<string, string>).Accept).toBe('application/activity+json');
	});

	test('rejects an unsafe URL without calling fetch', async () => {
		const apex = makeApex();
		await expect(
			safeRequestObject.call(apex, 'http://169.254.169.254/latest/meta-data'),
		).rejects.toThrow(UnsafeUrlError);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test('follows a redirect to a safe address', async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: `https://${PUBLIC_IP}/o/moved` },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ id: `https://${PUBLIC_IP}/o/moved`, type: 'Note' }), {
					status: 200,
				}),
			);

		const apex = makeApex();
		const result = await safeRequestObject.call(apex, `https://${PUBLIC_IP}/o/1`);

		expect(result).toEqual({ id: `https://${PUBLIC_IP}/o/moved`, type: 'Note' });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test('does not follow a redirect into a private address', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data' },
			}),
		);

		const apex = makeApex();
		await expect(safeRequestObject.call(apex, `https://${PUBLIC_IP}/o/1`)).rejects.toThrow(
			UnsafeUrlError,
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	test('gives up after too many redirects', async () => {
		fetchMock.mockImplementation(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: `https://${PUBLIC_IP}/o/next` },
				}),
		);

		const apex = makeApex();
		await expect(safeRequestObject.call(apex, `https://${PUBLIC_IP}/o/1`)).rejects.toThrow(
			/Too many redirects/,
		);
	});

	test('rejects a response advertising a body larger than the limit', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response('{}', {
				status: 200,
				headers: { 'content-length': String(10 * 1024 * 1024) },
			}),
		);

		const apex = makeApex();
		await expect(safeRequestObject.call(apex, `https://${PUBLIC_IP}/o/1`)).rejects.toThrow(
			/too large/,
		);
	});

	test('rejects a body that exceeds the limit while streaming', async () => {
		const oversized = 'x'.repeat(6 * 1024 * 1024);
		fetchMock.mockResolvedValueOnce(new Response(oversized, { status: 200 }));

		const apex = makeApex();
		await expect(safeRequestObject.call(apex, `https://${PUBLIC_IP}/o/1`)).rejects.toThrow(
			/exceeded/,
		);
	});

	test('signs the request when systemUser has a private key', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ id: `https://${PUBLIC_IP}/o/1`, type: 'Note' }), {
				status: 200,
			}),
		);

		const { generateKeyPairSync } = await import('node:crypto');
		const { privateKey } = generateKeyPairSync('rsa', {
			modulusLength: 2048,
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});

		const apex = makeApex({
			systemUser: {
				id: 'https://hakatashi.com/activitypub/u/hakatashi',
				type: 'Person',
				_meta: { privateKey },
			} as unknown as APObject,
		});

		await safeRequestObject.call(apex, `https://${PUBLIC_IP}/o/1`);

		const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
		const headers = init.headers as Record<string, string>;
		expect(headers.Signature).toContain(
			'keyId="https://hakatashi.com/activitypub/u/hakatashi#main-key"',
		);
		expect(headers.Date).toBeDefined();
	});
});
