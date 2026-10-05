import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import type { ExtractedMention } from '../../src/mastodon/statusContent.js';
import { fetchWebfinger, resolveActorByMention, resolveMentions } from '../../src/webfinger.js';

describe('webfinger unit tests', () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		server = createServer((req, res) => {
			const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
			if (url.pathname === '/.well-known/webfinger') {
				const resource = url.searchParams.get('resource');
				if (resource === `acct:alice@${req.headers.host}`) {
					res.setHeader('Content-Type', 'application/jrd+json');
					res.end(
						JSON.stringify({
							subject: resource,
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: `http://${req.headers.host}/users/alice`,
								},
							],
						}),
					);
					return;
				}
				if (resource === `acct:mediatype@${req.headers.host}`) {
					res.setHeader('Content-Type', 'application/jrd+json');
					res.end(
						JSON.stringify({
							subject: resource,
							links: [
								{
									rel: 'self',
									type: 'application/activity+json; charset=utf-8',
									href: `http://${req.headers.host}/users/mediatype`,
								},
							],
						}),
					);
					return;
				}
				if (resource === `acct:ldjson@${req.headers.host}`) {
					res.setHeader('Content-Type', 'application/jrd+json');
					res.end(
						JSON.stringify({
							subject: resource,
							links: [
								{
									rel: 'self',
									type: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"; charset=utf-8',
									href: `http://${req.headers.host}/users/ldjson`,
								},
							],
						}),
					);
					return;
				}
				if (resource === `acct:mismatch@${req.headers.host}`) {
					res.setHeader('Content-Type', 'application/jrd+json');
					res.end(
						JSON.stringify({
							subject: resource,
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'http://evil.com/users/mismatch',
								},
							],
						}),
					);
					return;
				}
				if (resource === `acct:impersonate@${req.headers.host}`) {
					res.setHeader('Content-Type', 'application/jrd+json');
					res.end(
						JSON.stringify({
							subject: resource,
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'https://hakatashi.com/activitypub/u/hakatashi',
								},
							],
						}),
					);
					return;
				}
				if (resource === `acct:badproto@${req.headers.host}`) {
					res.setHeader('Content-Type', 'application/jrd+json');
					res.end(
						JSON.stringify({
							subject: resource,
							links: [
								{
									rel: 'self',
									type: 'application/activity+json',
									href: 'javascript:alert(1)',
								},
							],
						}),
					);
					return;
				}
				if (resource === `acct:redirect@${req.headers.host}`) {
					res.writeHead(302, {
						Location: `http://${req.headers.host}/redirected-webfinger`,
					});
					res.end();
					return;
				}
				res.writeHead(404);
				res.end('Not found');
				return;
			}

			if (url.pathname === '/redirected-webfinger') {
				res.setHeader('Content-Type', 'application/jrd+json');
				res.end(
					JSON.stringify({
						subject: `acct:redirect@${req.headers.host}`,
						links: [
							{
								rel: 'self',
								type: 'application/activity+json',
								href: `http://${req.headers.host}/users/redirected`,
							},
						],
					}),
				);
				return;
			}

			res.writeHead(404);
			res.end();
		});

		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', () => {
				const addr = server.address();
				if (typeof addr === 'object' && addr !== null) {
					port = addr.port;
				}
				resolve();
			});
		});
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	});

	describe('fetchWebfinger', () => {
		it('returns actor IRI when remote returns valid JRD', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('alice', host);
			expect(iri).toBe(`http://${host}/users/alice`);
		});

		it('follows redirect and returns actor IRI', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('redirect', host);
			expect(iri).toBe(`http://${host}/users/redirected`);
		});

		it('returns undefined when user not found (404)', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('unknown', host);
			expect(iri).toBeUndefined();
		});

		it('handles media type with parameters (e.g. charset=utf-8)', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('mediatype', host);
			expect(iri).toBe(`http://${host}/users/mediatype`);
		});

		it('handles application/ld+json with activitystreams profile and charset', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('ldjson', host);
			expect(iri).toBe(`http://${host}/users/ldjson`);
		});

		it('returns undefined when self link origin does not match target host', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('mismatch', host);
			expect(iri).toBeUndefined();
		});

		it('returns undefined when remote server tries to impersonate local domain', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('impersonate', host);
			expect(iri).toBeUndefined();
		});

		it('returns undefined when self link has unsafe protocol', async () => {
			const host = `127.0.0.1:${port}`;
			const iri = await fetchWebfinger('badproto', host);
			expect(iri).toBeUndefined();
		});
	});

	describe('resolveActorByMention', () => {
		it('resolves local actor from store without webfinger request', async () => {
			const mockActor = {
				id: 'https://activitypub-dev.hakatashi.com/activitypub/u/localuser',
				type: 'Person',
				preferredUsername: 'localuser',
			};
			const getObjectSpy = vi
				.spyOn(apex.store, 'getObject')
				.mockImplementation((id: string) =>
					Promise.resolve(id === mockActor.id ? mockActor : undefined),
				);

			const resolved = await resolveActorByMention('localuser', undefined);
			expect(resolved).toEqual({
				actorIri: mockActor.id,
				url: mockActor.id,
				username: 'localuser',
				domain: undefined,
			});

			getObjectSpy.mockRestore();
		});

		it('resolves remote actor via webfinger and apex.resolveObject', async () => {
			const host = `127.0.0.1:${port}`;
			const remoteActorIri = `http://${host}/users/alice`;
			const mockRemoteActor = {
				id: remoteActorIri,
				url: `http://${host}/@alice`,
				type: 'Person',
				preferredUsername: 'alice',
			};

			const resolveObjectSpy = vi
				.spyOn(apex, 'resolveObject')
				.mockResolvedValueOnce(mockRemoteActor);

			const resolved = await resolveActorByMention('alice', host);
			expect(resolved).toEqual({
				actorIri: remoteActorIri,
				url: `http://${host}/@alice`,
				username: 'alice',
				domain: host,
			});

			resolveObjectSpy.mockRestore();
		});

		it('sanitizes dangerous remote actor URL and falls back to actor id', async () => {
			const host = `127.0.0.1:${port}`;
			const remoteActorIri = `http://${host}/users/alice`;
			const mockRemoteActor = {
				id: remoteActorIri,
				url: 'javascript:alert(1)',
				type: 'Person',
				preferredUsername: 'alice',
			};

			const resolveObjectSpy = vi
				.spyOn(apex, 'resolveObject')
				.mockResolvedValueOnce(mockRemoteActor);

			const resolved = await resolveActorByMention('alice', host);
			expect(resolved).toEqual({
				actorIri: remoteActorIri,
				url: remoteActorIri,
				username: 'alice',
				domain: host,
			});

			resolveObjectSpy.mockRestore();
		});

		it('returns undefined when remote actor has unsafe actor id', async () => {
			const host = `127.0.0.1:${port}`;
			const mockRemoteActor = {
				id: 'javascript:alert(1)',
				url: 'javascript:alert(1)',
				type: 'Person',
				preferredUsername: 'alice',
			};

			const resolveObjectSpy = vi
				.spyOn(apex, 'resolveObject')
				.mockResolvedValueOnce(mockRemoteActor);

			const resolved = await resolveActorByMention('alice', host);
			expect(resolved).toBeUndefined();

			resolveObjectSpy.mockRestore();
		});
	});

	describe('resolveMentions', () => {
		it('resolves multiple mentions and deduplicates keys', async () => {
			const host = `127.0.0.1:${port}`;
			const remoteActorIri = `http://${host}/users/alice`;
			const mockRemoteActor = {
				id: remoteActorIri,
				url: `http://${host}/@alice`,
				type: 'Person',
				preferredUsername: 'alice',
			};

			const resolveObjectSpy = vi.spyOn(apex, 'resolveObject').mockResolvedValue(mockRemoteActor);

			const mentions: ExtractedMention[] = [
				{
					raw: `@alice@${host}`,
					username: 'alice',
					domain: host,
					indices: [0, 10],
				},
				{
					raw: `@alice@${host}`,
					username: 'alice',
					domain: host,
					indices: [15, 25],
				},
			];

			const map = await resolveMentions(mentions);
			expect(map.size).toBe(1);
			expect(map.get(`@alice@${host}`)).toEqual({
				actorIri: remoteActorIri,
				url: `http://${host}/@alice`,
				username: 'alice',
				domain: host,
			});

			resolveObjectSpy.mockRestore();
		});
	});
});
