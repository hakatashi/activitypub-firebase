import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { FollowRelations } from '../../src/schema.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

type Handler = (req: IncomingMessage, res: ServerResponse, origin: string) => boolean;

describe('Mastodon Search API (Issue #227)', () => {
	let server: Server;
	let host: string;
	let origin: string;
	let requestedPaths: string[];
	let extraHandler: Handler | undefined;
	let me: LocalActor;

	const json = (res: ServerResponse, body: unknown, contentType = 'application/activity+json') => {
		res.writeHead(200, { 'content-type': contentType });
		res.end(JSON.stringify(body));
	};

	const carol = (base: string) => ({
		'@context': AS_CONTEXT,
		id: `${base}/users/carol`,
		type: 'Person',
		preferredUsername: 'carol',
		name: 'Carol',
		url: `${base}/@carol`,
		inbox: `${base}/users/carol/inbox`,
		outbox: `${base}/users/carol/outbox`,
		followers: `${base}/users/carol/followers`,
		following: `${base}/users/carol/following`,
	});

	const carolNote = (base: string, id: string, to: string[] = [PUBLIC]) => ({
		'@context': AS_CONTEXT,
		id: `${base}/users/carol/statuses/${id}`,
		type: 'Note',
		attributedTo: `${base}/users/carol`,
		content: `<p>note ${id}</p>`,
		published: '2026-10-01T00:00:00.000Z',
		url: `${base}/@carol/${id}`,
		to,
		cc: [],
	});

	beforeAll(async () => {
		server = createServer((req, res) => {
			const base = `http://${req.headers.host ?? ''}`;
			const url = new URL(req.url ?? '/', base);
			requestedPaths.push(url.pathname);
			if (extraHandler?.(req, res, base) === true) {
				return;
			}
			if (url.pathname === '/.well-known/webfinger') {
				if (url.searchParams.get('resource') === `acct:carol@${req.headers.host ?? ''}`) {
					json(
						res,
						{
							subject: `acct:carol@${req.headers.host ?? ''}`,
							links: [
								{ rel: 'self', type: 'application/activity+json', href: `${base}/users/carol` },
							],
						},
						'application/jrd+json',
					);
					return;
				}
			}
			if (url.pathname === '/users/carol') {
				json(res, carol(base));
				return;
			}
			// Mastodon と同じく、HTML 用の URL にも AP の JSON を返す。
			const htmlStatus = /^\/@carol\/(?<id>\w+)$/u.exec(url.pathname)?.groups?.id;
			if (htmlStatus === 'public' || htmlStatus === 'direct') {
				json(res, carolNote(base, htmlStatus, htmlStatus === 'public' ? [PUBLIC] : []));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
		origin = `http://${host}`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});

	beforeEach(async () => {
		await resetFirestore();
		requestedPaths = [];
		extraHandler = undefined;
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);
		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
		await createLocalActor('alice', { uid: 'uid-alice', id: '2' });
		await addAccessToken('token', 'read');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	const searchRequest = (query: Record<string, string>, token?: string) => {
		const req = request(mastodon).get('/api/v2/search').query(query);
		return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
	};

	const saveRemoteActor = async (id: string, preferredUsername: string) => {
		const actor = await apex.createActor(preferredUsername, preferredUsername, '', '', 'Person');
		actor.id = id;
		await apex.store.saveObject(actor);
		return actor;
	};

	describe('validation and authentication', () => {
		test('returns 400 when q is missing', async () => {
			const res = await searchRequest({});
			expect(res.status).toBe(400);
		});

		test('returns 401 for resolve=true without authentication and does not fetch remotely', async () => {
			const res = await searchRequest({ q: `carol@${host}`, resolve: 'true' });
			expect(res.status).toBe(401);
			expect(requestedPaths).toEqual([]);
		});

		test('returns 401 for offset without authentication', async () => {
			const res = await searchRequest({ q: 'a', type: 'accounts', offset: '1' });
			expect(res.status).toBe(401);
		});

		test('returns 401 for an invalid token', async () => {
			const res = await searchRequest({ q: 'a' }, 'invalid-token');
			expect(res.status).toBe(401);
		});

		test('returns 403 when the token lacks read:search', async () => {
			await addAccessToken('write-token', 'write');
			const res = await searchRequest({ q: 'a' }, 'write-token');
			expect(res.status).toBe(403);
		});
	});

	describe('account search', () => {
		test('finds local actors by username prefix without authentication', async () => {
			const res = await searchRequest({ q: 'hak' });
			expect(res.status).toBe(200);
			expect(res.body).toEqual({
				accounts: [expect.objectContaining({ id: '1', acct: 'hakatashi' })],
				statuses: [],
				hashtags: [],
			});
		});

		test('ignores a leading @ in plain queries', async () => {
			const res = await searchRequest({ q: '@ali' });
			expect(res.body.accounts.map((account: { acct: string }) => account.acct)).toEqual(['alice']);
		});

		test('finds a cached remote actor by acct without resolving', async () => {
			await saveRemoteActor('https://remote.example/users/bob', 'bob');
			await saveRemoteActor('https://other.example/users/bob', 'bob');

			const res = await searchRequest({ q: '@bob@remote.example' });
			expect(res.status).toBe(200);
			expect(res.body.accounts.map((account: { acct: string }) => account.acct)).toEqual([
				'bob@remote.example',
			]);
			expect(requestedPaths).toEqual([]);
		});

		test('resolves an unknown remote actor via WebFinger when resolve=true', async () => {
			const res = await searchRequest({ q: `@carol@${host}`, resolve: 'true' }, 'token');
			expect(res.status).toBe(200);
			expect(res.body.accounts).toEqual([
				expect.objectContaining({
					username: 'carol',
					acct: `carol@${host}`,
					display_name: 'Carol',
				}),
			]);
			await expect(apex.store.getObject(`${origin}/users/carol`)).resolves.toMatchObject({
				type: 'Person',
			});
		});

		test('does not resolve when resolve is not set', async () => {
			const res = await searchRequest({ q: `carol@${host}` }, 'token');
			expect(res.status).toBe(200);
			expect(res.body.accounts).toEqual([]);
			expect(requestedPaths).toEqual([]);
		});

		test('returns empty results when WebFinger fails', async () => {
			const res = await searchRequest({ q: `nobody@${host}`, resolve: 'true' }, 'token');
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ accounts: [], statuses: [], hashtags: [] });
		});

		test('returns empty results when the actor fetch fails', async () => {
			extraHandler = (req, res) => {
				if (req.url === '/users/carol') {
					res.writeHead(500);
					res.end();
					return true;
				}
				return false;
			};
			const res = await searchRequest({ q: `carol@${host}`, resolve: 'true' }, 'token');
			expect(res.status).toBe(200);
			expect(res.body.accounts).toEqual([]);
		});

		test('filters by following=true', async () => {
			const bob = await saveRemoteActor('https://remote.example/users/bob', 'bob');
			await saveRemoteActor('https://remote.example/users/bobby', 'bobby');
			await FollowRelations(escapeFirestoreKey(me.id), 'following')
				.doc(escapeFirestoreKey(bob.id))
				.set({
					actor: bob.id,
					followIri: `${me.id}/follow/1`,
					followMastodonId: null,
					state: 'accepted',
					createdAt: new Date() as never,
					follows: [{ iri: `${me.id}/follow/1`, state: 'accepted', mastodonId: null }],
				});

			const res = await searchRequest({ q: 'bob', following: 'true' }, 'token');
			expect(res.body.accounts.map((account: { acct: string }) => account.acct)).toEqual([
				'bob@remote.example',
			]);
		});

		test('applies limit and offset', async () => {
			await saveRemoteActor('https://remote.example/users/bob1', 'bob1');
			await saveRemoteActor('https://remote.example/users/bob2', 'bob2');
			await saveRemoteActor('https://remote.example/users/bob3', 'bob3');

			const res = await searchRequest(
				{ q: 'bob', type: 'accounts', limit: '1', offset: '1' },
				'token',
			);
			expect(res.body.accounts.map((account: { username: string }) => account.username)).toEqual([
				'bob2',
			]);
		});

		test('returns no statuses for non-URL queries (no full-text search)', async () => {
			const res = await searchRequest({ q: 'hakatashi', type: 'statuses' }, 'token');
			expect(res.body).toEqual({ accounts: [], statuses: [], hashtags: [] });
		});
	});

	describe('URL resolution', () => {
		test('resolves a remote status from its HTML URL and stores the author', async () => {
			const res = await searchRequest({ q: `${origin}/@carol/public`, resolve: 'true' }, 'token');
			expect(res.status).toBe(200);
			expect(res.body.accounts).toEqual([]);
			expect(res.body.statuses).toEqual([
				expect.objectContaining({
					uri: `${origin}/users/carol/statuses/public`,
					account: expect.objectContaining({ acct: `carol@${host}` }),
				}),
			]);
			await expect(apex.store.getObject(`${origin}/users/carol`)).resolves.toMatchObject({
				type: 'Person',
			});
		});

		test('finds a cached status from its HTML URL without resolving', async () => {
			await apex.store.saveObject(carol(origin) as never);
			await apex.store.saveObject(carolNote(origin, 'cached') as never);

			const res = await searchRequest({ q: `${origin}/@carol/cached` });
			expect(res.status).toBe(200);
			expect(res.body.statuses.map((status: { uri: string }) => status.uri)).toEqual([
				`${origin}/users/carol/statuses/cached`,
			]);
			expect(requestedPaths).toEqual([]);
		});

		test('resolves a remote actor from its URL', async () => {
			const res = await searchRequest({ q: `${origin}/users/carol`, resolve: 'true' }, 'token');
			expect(res.body.accounts).toEqual([expect.objectContaining({ acct: `carol@${host}` })]);
		});

		test('respects type when resolving URLs', async () => {
			const res = await searchRequest(
				{ q: `${origin}/users/carol`, resolve: 'true', type: 'statuses' },
				'token',
			);
			expect(res.body).toEqual({ accounts: [], statuses: [], hashtags: [] });
		});

		test('does not return statuses the viewer cannot see', async () => {
			const res = await searchRequest({ q: `${origin}/@carol/direct`, resolve: 'true' }, 'token');
			expect(res.status).toBe(200);
			expect(res.body.statuses).toEqual([]);
		});

		test('refetches by id when the fetched object claims another origin', async () => {
			const localhostOrigin = origin.replace('127.0.0.1', 'localhost');
			extraHandler = (req, res, base) => {
				if (req.url === '/spoof' && base === origin) {
					json(res, carolNote(localhostOrigin, 'spoofed'));
					return true;
				}
				return false;
			};
			const res = await searchRequest({ q: `${origin}/spoof`, resolve: 'true' }, 'token');
			expect(res.status).toBe(200);
			expect(res.body.statuses).toEqual([]);
			expect(requestedPaths).toContain('/users/carol/statuses/spoofed');
			await expect(
				apex.store.getObject(`${localhostOrigin}/users/carol/statuses/spoofed`),
			).resolves.toBeUndefined();
		});

		test('returns empty results for SSRF targets', async () => {
			const res = await searchRequest(
				{ q: 'http://169.254.169.254/latest/meta-data', resolve: 'true' },
				'token',
			);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ accounts: [], statuses: [], hashtags: [] });
		});

		test('returns empty results when the remote returns 404', async () => {
			const res = await searchRequest({ q: `${origin}/@carol/missing`, resolve: 'true' }, 'token');
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ accounts: [], statuses: [], hashtags: [] });
		});

		test('resolves local status URLs on the Mastodon domain without fetching', async () => {
			const note = {
				id: `${me.id}/notes/local-1`,
				type: 'Note',
				attributedTo: me.id,
				content: 'local note',
				published: '2026-10-01T00:00:00.000Z',
				to: [PUBLIC],
				cc: [],
			};
			await apex.store.saveObject(note as never);
			const id = await getOrAssignMastodonId(note.id, note.published);
			const { mastodonDomain } = await import('../../src/firebase.js');

			const res = await searchRequest({ q: `https://${mastodonDomain}/@hakatashi/${id}` });
			expect(res.body.statuses.map((status: { id: string }) => status.id)).toEqual([id]);
		});
	});

	describe('GET /api/v1/accounts/search', () => {
		test('requires authentication', async () => {
			const res = await request(mastodon).get('/api/v1/accounts/search').query({ q: 'hak' });
			expect(res.status).toBe(401);
		});

		test('returns accounts', async () => {
			const res = await request(mastodon)
				.get('/api/v1/accounts/search')
				.query({ q: `carol@${host}`, resolve: 'true' })
				.set('Authorization', 'Bearer token');
			expect(res.status).toBe(200);
			expect(res.body).toEqual([expect.objectContaining({ acct: `carol@${host}` })]);
		});
	});
});
