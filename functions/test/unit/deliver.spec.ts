import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../src/apex/index.js';
import type IApexStore from '../../src/apex/store/interface.js';

describe('apex federation (undici)', () => {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	let server: http.Server;
	let serverUrl: string;
	let lastReceivedRequest: {
		method?: string;
		url?: string;
		headers: http.IncomingHttpHeaders;
		body: string;
	};
	let mockStatusCode = 200;
	let mockResponseBody = '{"id":"https://remote.example/o/1","type":"Note"}';

	const mockStore = {} as IApexStore;

	const createApex = (overrides: Record<string, unknown> = {}) =>
		ActivitypubExpress({
			name: 'test-apex',
			version: '1.0.0',
			domain: 'example.com',
			actorParam: 'actor',
			objectParam: 'id',
			activityParam: 'id',
			routes: {
				actor: '/u/:actor',
				object: '/o/:id',
				activity: '/s/:id',
				inbox: '/u/:actor/inbox',
				outbox: '/u/:actor/outbox',
				followers: '/u/:actor/followers',
				following: '/u/:actor/following',
				liked: '/u/:actor/liked',
				collections: '/u/:actor/c/:id',
				blocked: '/u/:actor/blocked',
				rejections: '/u/:actor/rejections',
				rejected: '/u/:actor/rejected',
				shares: '/s/:id/shares',
				likes: '/s/:id/likes',
			},
			logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
			store: mockStore,
			offlineMode: false,
			...overrides,
		});

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			let body = '';
			req.on('data', (chunk: Buffer) => {
				body += chunk.toString('utf-8');
			});
			req.on('end', () => {
				lastReceivedRequest = {
					method: req.method,
					url: req.url,
					headers: req.headers,
					body,
				};
				res.writeHead(mockStatusCode, { 'Content-Type': 'application/activity+json' });
				res.end(mockResponseBody);
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address() as AddressInfo;
				serverUrl = `http://127.0.0.1:${addr.port}`;
				resolve();
			});
		});
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
	});

	describe('deliver', () => {
		test('successfully sends activity with valid HTTP signature and Digest headers', async () => {
			mockStatusCode = 200;
			mockResponseBody = 'ok';
			const apex = createApex();
			const actorId = 'https://example.com/u/alice#main-key';
			const activity = JSON.stringify({
				id: 'https://example.com/s/1',
				type: 'Create',
				actor: 'https://example.com/u/alice',
			});
			const address = `${serverUrl}/inbox`;

			const result = await apex.deliver(actorId, activity, address, privateKey);

			expect(result).not.toBeNull();
			expect(result?.statusCode).toBe(200);
			expect(result?.body).toBe('ok');

			expect(lastReceivedRequest.method).toBe('POST');
			expect(lastReceivedRequest.url).toBe('/inbox');
			expect(lastReceivedRequest.body).toBe(activity);
			expect(lastReceivedRequest.headers['content-type']).toBe(
				'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
			);
			expect(lastReceivedRequest.headers['user-agent']).toBe(
				'test-apex/1.0.0 (+http://example.com)',
			);
			expect(lastReceivedRequest.headers.date).toBeDefined();
			expect(lastReceivedRequest.headers.digest).toMatch(/^SHA-256=/);

			// Verify HTTP Signature header
			const sigHeader = lastReceivedRequest.headers.signature as string;
			expect(sigHeader).toBeDefined();
			expect(sigHeader).toContain(`keyId="${actorId}"`);
			expect(sigHeader).toContain('algorithm="rsa-sha256"');
			expect(sigHeader).toContain('headers="(request-target) host date digest"');

			const sigMatch = /signature="(?<sig>[^"]+)"/.exec(sigHeader);
			expect(sigMatch).not.toBeNull();
			const signatureBase64 = sigMatch?.groups?.sig ?? '';

			const date = lastReceivedRequest.headers.date as string;
			const digest = lastReceivedRequest.headers.digest as string;
			const host = lastReceivedRequest.headers.host as string;
			const stringToSign = `(request-target): post /inbox\nhost: ${host}\ndate: ${date}\ndigest: ${digest}`;

			const isValid = verify(
				'sha256',
				Buffer.from(stringToSign, 'utf-8'),
				publicKey,
				Buffer.from(signatureBase64, 'base64'),
			);
			expect(isValid).toBe(true);
		});

		test('resolves with status code on 4xx / 5xx responses (does not throw)', async () => {
			const apex = createApex();
			const actorId = 'https://example.com/u/alice#main-key';
			const activity = '{"type":"Like"}';
			const address = `${serverUrl}/inbox`;

			for (const status of [401, 403, 404, 410, 500, 503]) {
				mockStatusCode = status;
				mockResponseBody = `error ${status}`;
				// oxlint-disable-next-line no-await-in-loop
				const result = await apex.deliver(actorId, activity, address, privateKey);
				expect(result?.statusCode).toBe(status);
				expect(result?.body).toBe(`error ${status}`);
			}
		});

		test('rejects on network error (e.g. invalid host)', async () => {
			const apex = createApex({ requestTimeout: 500 });
			const actorId = 'https://example.com/u/alice#main-key';
			const activity = '{"type":"Like"}';
			// Connect to an unused port where connection will fail immediately
			const address = 'http://127.0.0.1:1';

			await expect(apex.deliver(actorId, activity, address, privateKey)).rejects.toThrow();
		});

		test('returns null when delivering to localhost in production environment', async () => {
			const apex = createApex();
			const originalEnv = process.env.NODE_ENV;
			try {
				process.env.NODE_ENV = 'production';
				const result = await apex.deliver(
					'https://example.com/u/alice',
					'{"type":"Like"}',
					'http://127.0.0.1:8080/inbox',
					privateKey,
				);
				expect(result).toBeNull();
			} finally {
				process.env.NODE_ENV = originalEnv;
			}
		});
	});

	describe('requestObject', () => {
		test('fetches object with systemUser HTTP signature and normalizes JSON-LD', async () => {
			mockStatusCode = 200;
			mockResponseBody = JSON.stringify({
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `${serverUrl}/o/test-note`,
				type: 'Note',
				content: 'hello',
			});

			const apex = createApex({
				systemUser: {
					id: 'https://example.com/u/system',
					_meta: { privateKey },
				},
			});

			const obj = await apex.requestObject(`${serverUrl}/o/test-note`);
			expect(obj.id).toBe(`${serverUrl}/o/test-note`);
			expect(obj.type).toBe('Note');

			expect(lastReceivedRequest.method).toBe('GET');
			expect(lastReceivedRequest.url).toBe('/o/test-note');
			expect(lastReceivedRequest.headers.accept).toBe('application/activity+json');
			expect(lastReceivedRequest.headers.signature).toContain(
				'keyId="https://example.com/u/system"',
			);
		});

		test('throws on 4xx/5xx HTTP responses', async () => {
			mockStatusCode = 404;
			mockResponseBody = 'Not found';

			const apex = createApex();
			await expect(apex.requestObject(`${serverUrl}/o/missing`)).rejects.toThrow(
				/Request failed with status code 404/,
			);
		});
	});
});
