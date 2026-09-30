import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

describe('apex jsonldContextLoader and validators.jsonld SSRF protection (ADR-0054)', () => {
	let server: http.Server;
	let serverUrl: string;

	const mockSaveContext = vi.fn().mockResolvedValue(true);
	const mockGetContext = vi.fn().mockResolvedValue(undefined);
	const mockStore = {
		getContext: mockGetContext,
		saveContext: mockSaveContext,
	} as unknown as IApexStore;

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
			offlineMode: true,
			remoteFetchPolicy: { allowedProtocols: ['http:'], allowedRanges: ['loopback'] },
			...overrides,
		});

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			if (req.url === '/redirect-valid') {
				res.writeHead(302, { Location: `${serverUrl}/valid` });
				res.end();
				return;
			}
			if (req.url === '/redirect-to-unsafe') {
				res.writeHead(302, { Location: 'http://169.254.169.254/metadata' });
				res.end();
				return;
			}
			if (req.url === '/too-large') {
				res.writeHead(200, { 'Content-Type': 'application/ld+json' });
				// 5MB 超のデータを送る (6MB)
				const largeChunk = 'A'.repeat(1024 * 1024);
				res.write('{"@context": "');
				for (let i = 0; i < 6; i++) {
					res.write(largeChunk);
				}
				res.write('"}');
				res.end();
				return;
			}
			if (req.url === '/invalid-json') {
				res.writeHead(200, { 'Content-Type': 'application/ld+json' });
				res.end('invalid json content');
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/ld+json' });
			res.end(JSON.stringify({ '@context': { litepub: 'http://litepub.org/ns#' } }));
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

	describe('jsonldContextLoader', () => {
		test('returns cached core context immediately without network fetch', async () => {
			const apex = createApex();
			const result = await apex.jsonldContextLoader('https://www.w3.org/ns/activitystreams');
			expect(result.documentUrl).toBe('https://www.w3.org/ns/activitystreams');
			expect(mockGetContext).not.toHaveBeenCalled();
		});

		test('returns store cached context if present in DB', async () => {
			const apex = createApex();
			mockGetContext.mockResolvedValueOnce({
				documentUrl: 'https://example.com/context.jsonld',
				document: { '@context': {} },
			});
			const result = await apex.jsonldContextLoader('https://example.com/context.jsonld');
			expect(result.documentUrl).toBe('https://example.com/context.jsonld');
			expect(mockGetContext).toHaveBeenCalledWith('https://example.com/context.jsonld');
		});

		test('blocks unsafe url (cloud metadata, private IP, localhost) under default policy', async () => {
			const apex = createApex({ remoteFetchPolicy: {} });
			const unsafeUrls = [
				'http://169.254.169.254/metadata',
				'http://127.0.0.1:8080/context.jsonld',
				'http://10.0.0.1/context.jsonld',
				'https://192.168.1.1/context.jsonld',
				'http://localhost/context.jsonld',
			];

			for (const url of unsafeUrls) {
				// oxlint-disable-next-line no-await-in-loop
				await expect(apex.jsonldContextLoader(url)).rejects.toThrow();
			}
		});

		test('fetches external context safely under permissive policy and saves to store', async () => {
			const apex = createApex();
			const contextUrl = `${serverUrl}/valid`;
			const result = await apex.jsonldContextLoader(contextUrl);

			expect(result.documentUrl).toBe(contextUrl);
			expect(result.document).toEqual({
				'@context': { litepub: 'http://litepub.org/ns#' },
			});
			expect(mockSaveContext).toHaveBeenCalledWith({
				contextUrl: null,
				documentUrl: contextUrl,
				document: { '@context': { litepub: 'http://litepub.org/ns#' } },
			});
		});

		test('follows safe redirects and preserves original documentUrl', async () => {
			const apex = createApex();
			const contextUrl = `${serverUrl}/redirect-valid`;
			const result = await apex.jsonldContextLoader(contextUrl);

			expect(result.documentUrl).toBe(contextUrl);
			expect(result.document).toEqual({
				'@context': { litepub: 'http://litepub.org/ns#' },
			});
		});

		test('blocks redirect to unsafe address (SSRF via redirect)', async () => {
			const apex = createApex();
			const contextUrl = `${serverUrl}/redirect-to-unsafe`;
			await expect(apex.jsonldContextLoader(contextUrl)).rejects.toThrow(
				/Address not allowed: 169.254.169.254/,
			);
		});

		test('rejects response exceeding 5MB limit', async () => {
			const apex = createApex();
			const contextUrl = `${serverUrl}/too-large`;
			await expect(apex.jsonldContextLoader(contextUrl)).rejects.toThrow(/Response exceeded/);
		});

		test('rejects invalid JSON response', async () => {
			const apex = createApex();
			const contextUrl = `${serverUrl}/invalid-json`;
			await expect(apex.jsonldContextLoader(contextUrl)).rejects.toThrow();
		});
	});

	describe('validators.jsonld 400 response on failed context fetch', () => {
		test('responds with 400 Bad Request when JSON-LD context fails SSRF check', async () => {
			const apex = createApex({ remoteFetchPolicy: {} });

			let status = 0;
			let responseBody = '';
			const req = {
				method: 'POST',
				app: { locals: { apex } },
				is: vi.fn().mockReturnValue(true),
				accepts: vi.fn().mockReturnValue(false),
				body: {
					'@context': [
						'https://www.w3.org/ns/activitystreams',
						'http://169.254.169.254/meta.jsonld',
					],
					type: 'Create',
				},
			} as unknown as Request;

			const res = {
				status: vi.fn().mockImplementation((s: number) => {
					status = s;
					return {
						send: vi.fn().mockImplementation((b: string) => {
							responseBody = b;
						}),
					};
				}),
			} as unknown as Response;

			const next = vi.fn() as NextFunction;

			await apex.net.validators.jsonld(req, res, next);

			expect(status).toBe(400);
			expect(responseBody).toBe('Error processing request JSON-LD');
			expect(next).not.toHaveBeenCalled();
		});
	});
});
