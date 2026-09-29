import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Apex, APObject } from '../../../src/apex/index.js';
// @ts-expect-error -- JS モジュール (型定義なし)
import { requestObject } from '../../../src/apex/pub/federation.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

// federation.js は CJS として require されるため ssrf.js のクラスとは別インスタンスになり、
// instanceof では比較できない。メッセージで照合する。
const NOT_ALLOWED = /Address not allowed/;

// テストは実際の localhost サーバーへ到達させる。policy はループバックと http を許可する。
// 「どのアドレスを内部とみなすか」を注入できることの確認も兼ねる。
const makeApex = (overrides: Record<string, unknown> = {}, policy: object = {}) =>
	({
		makeUserAgentString: () => 'activitypub-firebase-test/1.0',
		requestTimeout: 5000,
		fromJSONLD: (obj: unknown) => Promise.resolve(obj as APObject),
		systemUser: undefined,
		logger: { warn: vi.fn() },
		settings: {
			remoteFetchPolicy: {
				allowedProtocols: ['http:'],
				allowedRanges: ['loopback'],
				...policy,
			},
		},
		...overrides,
	}) as unknown as Apex;

const request = (apex: Apex, id: string): Promise<APObject> =>
	(requestObject as (this: Apex, id: string) => Promise<APObject>).call(apex, id);

describe('apex requestObject (SSRF-safe)', () => {
	let server: Server;
	let handler: Handler;
	let origin: string;

	beforeEach(async () => {
		server = createServer((req, res) => handler(req, res));
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});

	const json = (res: ServerResponse, body: unknown, status = 200) => {
		res.writeHead(status, { 'content-type': 'application/activity+json' });
		res.end(JSON.stringify(body));
	};

	test('fetches and normalizes an object', async () => {
		let accept: string | undefined;
		handler = (req, res) => {
			accept = req.headers.accept;
			json(res, { id: `${origin}/o/1`, type: 'Note' });
		};
		await expect(request(makeApex(), `${origin}/o/1`)).resolves.toEqual({
			id: `${origin}/o/1`,
			type: 'Note',
		});
		expect(accept).toBe('application/activity+json');
	});

	test('rejects an unsafe URL without connecting', async () => {
		handler = vi.fn();
		await expect(request(makeApex(), 'http://169.254.169.254/latest/meta-data')).rejects.toThrow(
			NOT_ALLOWED,
		);
		expect(handler).not.toHaveBeenCalled();
	});

	test('is strict by default (loopback over http is rejected)', async () => {
		handler = vi.fn();
		const apex = makeApex({ settings: {} });
		await expect(request(apex, `${origin}/o/1`)).rejects.toThrow(/Protocol not allowed/);
		expect(handler).not.toHaveBeenCalled();
	});

	test('follows a redirect to a safe address', async () => {
		handler = (req, res) => {
			if (req.url === '/o/1') {
				res.writeHead(302, { location: '/o/moved' });
				res.end();
			} else {
				json(res, { id: `${origin}/o/moved`, type: 'Note' });
			}
		};
		await expect(request(makeApex(), `${origin}/o/1`)).resolves.toEqual({
			id: `${origin}/o/moved`,
			type: 'Note',
		});
	});

	test('does not follow a redirect into a private address', async () => {
		handler = (_req, res) => {
			res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
			res.end();
		};
		await expect(request(makeApex(), `${origin}/o/1`)).rejects.toThrow(NOT_ALLOWED);
	});

	test('pins the connection to the validated address (DNS rebinding)', async () => {
		handler = (_req, res) => {
			json(res, { id: 'x', type: 'Note' });
		};
		const { port } = server.address() as AddressInfo;
		// ホスト名は検証時に 127.0.0.1 と解決される。接続時に再解決されていれば到達できない。
		const apex = makeApex({}, { resolveAddresses: () => Promise.resolve(['127.0.0.1']) });
		await expect(request(apex, `http://rebind.invalid:${port}/o/1`)).resolves.toEqual({
			id: 'x',
			type: 'Note',
		});
	});

	test('gives up after too many redirects', async () => {
		handler = (_req, res) => {
			res.writeHead(302, { location: '/o/next' });
			res.end();
		};
		await expect(request(makeApex(), `${origin}/o/1`)).rejects.toThrow(/Too many redirects/);
	});

	test('rejects an error status', async () => {
		handler = (_req, res) => {
			res.writeHead(404);
			res.end();
		};
		await expect(request(makeApex(), `${origin}/o/1`)).rejects.toThrow(/status code 404/);
	});

	test('rejects a response advertising a body larger than the limit', async () => {
		handler = (_req, res) => {
			res.writeHead(200, { 'content-length': String(10 * 1024 * 1024) });
			res.write('{}');
		};
		await expect(request(makeApex(), `${origin}/o/1`)).rejects.toThrow(/too large/);
	});

	test('rejects a body that exceeds the limit while streaming', async () => {
		handler = (_req, res) => {
			res.writeHead(200);
			res.end('x'.repeat(6 * 1024 * 1024));
		};
		await expect(request(makeApex(), `${origin}/o/1`)).rejects.toThrow(/exceeded/);
	});

	test('signs the request when systemUser has a private key', async () => {
		let headers: IncomingMessage['headers'] = {};
		handler = (req, res) => {
			headers = req.headers;
			json(res, { id: `${origin}/o/1`, type: 'Note' });
		};
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
			},
		});
		await request(apex, `${origin}/o/1`);
		expect(headers.signature).toContain(
			'keyId="https://hakatashi.com/activitypub/u/hakatashi#main-key"',
		);
		expect(headers.date).toBeDefined();
	});
});
