import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import {
	isPermanentFetchFailure,
	isTransientFailure,
	isTransientStatus,
	PermanentFetchError,
	TransientFetchError,
} from '../../../src/apex/pub/fetchErrors.js';
import { UnsafeUrlError } from '../../../src/apex/pub/ssrf.js';
import type IApexStore from '../../../src/apex/store/interface.js';

// inbox が一時的な失敗で 4xx を返さないための、リモート取得失敗の分類 (ADR-0115)
describe('transient remote fetch failures (ADR-0115)', () => {
	let server: http.Server;
	let serverUrl: string;
	let closedUrl: string;

	const createApex = (remoteFetchPolicy: Record<string, unknown> = {}) =>
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
			store: {
				getContext: vi.fn().mockResolvedValue(undefined),
				saveContext: vi.fn().mockResolvedValue(true),
			} as unknown as IApexStore,
			offlineMode: true,
			remoteFetchPolicy: {
				allowedProtocols: ['http:'],
				allowedRanges: ['loopback'],
				...remoteFetchPolicy,
			},
		});

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			const status = /^\/status\/(?<code>\d+)/.exec(req.url ?? '')?.groups?.code;
			if (status) {
				res.writeHead(Number(status));
				res.end('error');
				return;
			}
			if (req.url?.startsWith('/truncated')) {
				// Content-Length より短い本文で切断する
				res.writeHead(200, { 'Content-Type': 'application/ld+json', 'Content-Length': '1000' });
				res.write('{"@context": {');
				res.socket?.destroy();
				return;
			}
			if (req.url?.startsWith('/invalid-json')) {
				res.writeHead(200, { 'Content-Type': 'application/ld+json' });
				res.end('<html>not json</html>');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/ld+json' });
			res.end(JSON.stringify({ '@context': { litepub: 'http://litepub.org/ns#' } }));
		});
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		// 一度 listen して閉じたポートは接続を拒否する
		const closed = http.createServer();
		await new Promise<void>((resolve) => {
			closed.listen(0, '127.0.0.1', resolve);
		});
		closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
		await new Promise((resolve) => {
			closed.close(resolve);
		});
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});

	describe('isTransientStatus', () => {
		test.each([500, 502, 503, 504, 408, 429])('%i is transient', (code) => {
			expect(isTransientStatus(code)).toBe(true);
		});
		test.each([400, 401, 403, 404, 410, 422])('%i is permanent', (code) => {
			expect(isTransientStatus(code)).toBe(false);
		});
	});

	describe('isTransientFailure', () => {
		test('finds TransientFetchError through cause and jsonld details.cause', () => {
			const transient = new TransientFetchError('boom');
			expect(isTransientFailure(transient)).toBe(true);
			expect(isTransientFailure(new Error('wrapped', { cause: transient }))).toBe(true);
			const jsonldError = Object.assign(new Error('loading remote context failed'), {
				details: { cause: new Error('inner', { cause: transient }) },
			});
			expect(isTransientFailure(jsonldError)).toBe(true);
		});

		test('is false for other errors', () => {
			expect(isTransientFailure(new Error('invalid'))).toBe(false);
			expect(isTransientFailure(undefined)).toBe(false);
			expect(isTransientFailure('string error')).toBe(false);
		});
	});

	describe('isPermanentFetchFailure', () => {
		test('identifies PermanentFetchError and UnsafeUrlError', () => {
			const permanent = new PermanentFetchError('not found', 404);
			expect(isPermanentFetchFailure(permanent)).toBe(true);
			expect(isPermanentFetchFailure(new Error('wrapped', { cause: permanent }))).toBe(true);
			expect(isPermanentFetchFailure(new UnsafeUrlError('blocked'))).toBe(true);
		});

		test('returns false when error is transient even if wrapped in generic error', () => {
			const transient = new TransientFetchError('timeout');
			expect(isPermanentFetchFailure(transient)).toBe(false);
			expect(isPermanentFetchFailure(new Error('wrapped', { cause: transient }))).toBe(false);
		});

		test('returns false for generic errors (e.g. database error)', () => {
			expect(isPermanentFetchFailure(new Error('Firestore error'))).toBe(false);
			expect(isPermanentFetchFailure(undefined)).toBe(false);
			expect(isPermanentFetchFailure('string error')).toBe(false);
		});
	});

	// requestObject (署名者の鍵の取得など) と jsonldContextLoader で同じ分類になること
	const loaders = [
		[
			'requestObject',
			(apex: ReturnType<typeof createApex>, url: string) => apex.requestObject(url),
		],
		[
			'jsonldContextLoader',
			(apex: ReturnType<typeof createApex>, url: string) => apex.jsonldContextLoader(url),
		],
	] as const;

	describe.each(loaders)('%s', (_name, load) => {
		const expectTransient = async (promise: Promise<unknown>, transient: boolean) => {
			const err: unknown = await promise.then(
				() => undefined,
				(e: unknown) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect(isTransientFailure(err)).toBe(transient);
		};

		test.each([500, 503, 408, 429])('treats HTTP %i as transient', async (code) => {
			await expectTransient(load(createApex(), `${serverUrl}/status/${code}`), true);
		});

		test.each([400, 403, 404, 410])('treats HTTP %i as permanent', async (code) => {
			await expectTransient(load(createApex(), `${serverUrl}/status/${code}`), false);
		});

		test('treats connection failure as transient', async () => {
			await expectTransient(load(createApex(), `${closedUrl}/context`), true);
		});

		test('treats a body cut off mid-response as transient', async () => {
			await expectTransient(load(createApex(), `${serverUrl}/truncated`), true);
		});

		test('treats DNS resolution failure as transient', async () => {
			const apex = createApex({ resolveAddresses: () => Promise.resolve([]) });
			await expectTransient(load(apex, 'http://unresolvable.invalid/context'), true);
		});

		test('treats SSRF-blocked URL as permanent', async () => {
			await expectTransient(load(createApex(), 'http://169.254.169.254/meta'), false);
		});

		test('treats a non-JSON 200 response as permanent', async () => {
			await expectTransient(load(createApex(), `${serverUrl}/invalid-json`), false);
		});
	});

	describe('validators.jsonld', () => {
		const postJsonld = async (apex: ReturnType<typeof createApex>, contextUrl: string) => {
			let status = 0;
			const req = {
				method: 'POST',
				app: { locals: { apex } },
				is: vi.fn().mockReturnValue(true),
				accepts: vi.fn().mockReturnValue(false),
				body: {
					'@context': ['https://www.w3.org/ns/activitystreams', contextUrl],
					id: 'https://remote.example/follows/1',
					type: 'Follow',
					actor: 'https://remote.example/u/alice',
					object: 'https://example.com/u/hakatashi',
				},
			} as unknown as Request;
			const res = {
				status: vi.fn().mockImplementation((s: number) => {
					status = s;
					return { send: vi.fn() };
				}),
			} as unknown as Response;
			const next = vi.fn() as NextFunction;
			await apex.net.validators.jsonld(req, res, next);
			return { status, next };
		};

		// jsonld.js は解決済みのコンテキストを URL ごとにキャッシュするため、テストごとに URL を変える
		test('responds 503 when the @context host returns 5xx', async () => {
			const { status, next } = await postJsonld(createApex(), `${serverUrl}/status/503?a`);
			expect(status).toBe(503);
			expect(next).not.toHaveBeenCalled();
		});

		test('responds 503 when the @context host is unreachable', async () => {
			const { status } = await postJsonld(createApex(), `${closedUrl}/context?b`);
			expect(status).toBe(503);
		});

		test('responds 503 when the @context host is rate limiting', async () => {
			const { status } = await postJsonld(createApex(), `${serverUrl}/status/429?c`);
			expect(status).toBe(503);
		});

		test('responds 400 when the @context does not exist', async () => {
			const { status } = await postJsonld(createApex(), `${serverUrl}/status/404?d`);
			expect(status).toBe(400);
		});

		test('responds 400 when the @context is not valid JSON', async () => {
			const { status } = await postJsonld(createApex(), `${serverUrl}/invalid-json?e`);
			expect(status).toBe(400);
		});

		test('responds 400 when the @context is blocked by the SSRF guard', async () => {
			const { status } = await postJsonld(createApex(), 'http://169.254.169.254/meta.jsonld');
			expect(status).toBe(400);
		});

		test('passes a valid external @context through', async () => {
			const { status, next } = await postJsonld(createApex(), `${serverUrl}/valid?f`);
			expect(status).toBe(0);
			expect(next).toHaveBeenCalledWith();
		});
	});
});
