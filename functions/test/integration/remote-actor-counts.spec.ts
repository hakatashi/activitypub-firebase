import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { omit } from 'lodash-es';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { apex } from '../../src/apex.js';
import type { APObject } from '../../src/apex/index.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { userIdsToAccountsMap } from '../../src/mastodon/presenters/account.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import {
	REMOTE_ACTOR_COUNTS_TTL_MS,
	refreshRemoteActorCounts,
	remoteActorRefreshQueue,
	remoteActorRefreshTaskId,
} from '../../src/social/remoteActorCounts.js';
import { remoteActorRefreshTask } from '../../src/tasks.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const makeTaskRequest = (data: unknown) =>
	({ data }) as unknown as Parameters<typeof remoteActorRefreshTask.run>[0];

describe('remote actor counts (Issue #229)', () => {
	let server: Server;
	let origin: string;
	let handler: Handler | undefined;
	let carolIri: string;
	let enqueueSpy: MockInstance<typeof remoteActorRefreshQueue.enqueue>;

	const json = (res: ServerResponse, body: unknown) => {
		res.writeHead(200, { 'content-type': 'application/activity+json' });
		res.end(JSON.stringify(body));
	};

	const collection = (path: string, totalItems?: number) => ({
		'@context': AS_CONTEXT,
		id: `${origin}${path}`,
		type: 'OrderedCollection',
		...(totalItems === undefined ? {} : { totalItems }),
	});

	const carolObject = (extra: Record<string, unknown> = {}) => ({
		'@context': AS_CONTEXT,
		id: carolIri,
		type: 'Person',
		preferredUsername: 'carol',
		name: 'Carol',
		published: '2020-05-06T12:34:56Z',
		inbox: `${carolIri}/inbox`,
		outbox: `${carolIri}/outbox`,
		followers: `${carolIri}/followers`,
		following: `${carolIri}/following`,
		...extra,
	});

	// 既定では actor 本体とコレクションの件数を返す。handler で個別に差し替えられる。
	const defaultHandler = (req: IncomingMessage, res: ServerResponse) => {
		const path = new URL(req.url ?? '/', origin).pathname;
		if (path === '/users/carol') {
			json(res, carolObject());
			return;
		}
		const counts: Record<string, number> = {
			'/users/carol/followers': 12,
			'/users/carol/following': 34,
			'/users/carol/outbox': 56,
		};
		const count = counts[path];
		if (count !== undefined) {
			json(res, collection(path, count));
			return;
		}
		res.writeHead(404);
		res.end();
	};

	const saveCarol = (extra: Record<string, unknown> = {}) =>
		apex.store.saveObject({
			id: carolIri,
			type: 'Person',
			preferredUsername: 'carol',
			name: 'Carol',
			published: '2020-05-06T12:34:56Z',
			inbox: `${carolIri}/inbox`,
			outbox: `${carolIri}/outbox`,
			followers: `${carolIri}/followers`,
			following: `${carolIri}/following`,
			...extra,
		} as unknown as APObject);

	const getCarolMeta = async () => (await apex.store.getObject(carolIri, true))?._meta;

	beforeAll(async () => {
		server = createServer((req, res) => {
			if (handler?.(req, res) === true) {
				return;
			}
			defaultHandler(req, res);
		});
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		carolIri = `${origin}/users/carol`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});

	beforeEach(async () => {
		await resetFirestore();
		handler = undefined;
		enqueueSpy = vi.spyOn(remoteActorRefreshQueue, 'enqueue').mockResolvedValue(undefined);
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
		await saveCarol();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('refreshRemoteActorCounts', () => {
		test('stores totalItems of the collections and the date of the latest local note', async () => {
			await apex.store.saveObject({
				id: `${carolIri}/statuses/1`,
				type: 'Note',
				attributedTo: carolIri,
				content: 'old',
				published: '2026-09-01T10:00:00Z',
				to: [PUBLIC],
			} as unknown as APObject);
			await apex.store.saveObject({
				id: `${carolIri}/statuses/2`,
				type: 'Note',
				attributedTo: carolIri,
				content: 'new',
				published: '2026-09-30T23:00:00Z',
				to: [PUBLIC],
			} as unknown as APObject);

			const now = new Date('2026-10-09T00:00:00.000Z');
			await refreshRemoteActorCounts(carolIri, now);

			expect(await getCarolMeta()).toMatchObject({
				followersCount: 12,
				followingCount: 34,
				statusesCount: 56,
				lastStatusAt: '2026-09-30',
				countsFetchedAt: now.toISOString(),
			});
		});

		test('keeps previous counts for collections that cannot be fetched', async () => {
			await refreshRemoteActorCounts(carolIri);

			handler = (req, res) => {
				const path = new URL(req.url ?? '/', origin).pathname;
				if (path === '/users/carol/followers') {
					res.writeHead(500);
					res.end();
					return true;
				}
				if (path === '/users/carol/following') {
					// 件数を隠したコレクション
					json(res, collection(path));
					return true;
				}
				if (path === '/users/carol/outbox') {
					json(res, collection(path, 57));
					return true;
				}
				return false;
			};
			const now = new Date('2026-10-10T00:00:00.000Z');
			await refreshRemoteActorCounts(carolIri, now);

			expect(await getCarolMeta()).toMatchObject({
				followersCount: 12,
				followingCount: 34,
				statusesCount: 57,
				countsFetchedAt: now.toISOString(),
			});
		});

		test('records the fetch time without counts when the remote server is down', async () => {
			handler = (req) => {
				req.socket.destroy();
				return true;
			};
			await refreshRemoteActorCounts(carolIri);

			const meta = await getCarolMeta();
			expect(meta?.countsFetchedAt).toEqual(expect.any(String));
			expect(meta?.followersCount).toBeUndefined();
		});

		test('does not fetch anything for local actors', async () => {
			const requestSpy = vi.spyOn(apex, 'requestObject');
			await refreshRemoteActorCounts('https://example.com/activitypub/u/hakatashi');
			expect(requestSpy).not.toHaveBeenCalled();
		});

		test('keeps the stored counts when the actor is overwritten by an Update', async () => {
			await refreshRemoteActorCounts(carolIri);
			await saveCarol({ name: 'Carol (updated)' });

			expect(await getCarolMeta()).toMatchObject({ followersCount: 12, statusesCount: 56 });
		});

		test('updates actor properties (icon, image, name) while preserving _meta', async () => {
			handler = (req, res) => {
				const path = new URL(req.url ?? '/', origin).pathname;
				if (path === '/users/carol') {
					json(
						res,
						carolObject({
							name: 'Carol Danvers',
							summary: 'Higher, further, faster',
							icon: {
								type: 'Image',
								url: 'https://example.com/carol-new-avatar.png',
							},
							image: {
								type: 'Image',
								url: 'https://example.com/carol-new-header.png',
							},
						}),
					);
					return true;
				}
				return false;
			};

			const now = new Date('2026-10-10T12:00:00.000Z');
			await refreshRemoteActorCounts(carolIri, now);

			const carol = await apex.store.getObject(carolIri, true);
			expect(carol).toMatchObject({
				name: ['Carol Danvers'],
				summary: ['Higher, further, faster'],
				icon: [
					{
						type: 'Image',
						url: ['https://example.com/carol-new-avatar.png'],
					},
				],
				image: [
					{
						type: 'Image',
						url: ['https://example.com/carol-new-header.png'],
					},
				],
			});
			expect(carol?._meta).toMatchObject({
				followersCount: 12,
				followingCount: 34,
				statusesCount: 56,
				countsFetchedAt: now.toISOString(),
			});
		});

		test('preserves existing actor when remote actor endpoint returns an error', async () => {
			handler = (req, res) => {
				const path = new URL(req.url ?? '/', origin).pathname;
				if (path === '/users/carol') {
					res.writeHead(500);
					res.end();
					return true;
				}
				return false;
			};

			const now = new Date('2026-10-10T12:00:00.000Z');
			await refreshRemoteActorCounts(carolIri, now);

			const carol = await apex.store.getObject(carolIri, true);
			expect(carol?.name).toBe('Carol');
			expect(carol?._meta).toMatchObject({
				countsFetchedAt: now.toISOString(),
			});
		});
	});

	describe('remoteActorRefreshTask', () => {
		test('refreshes the counts of the given actor', async () => {
			await remoteActorRefreshTask.run(makeTaskRequest({ actorIri: carolIri }));
			expect(await getCarolMeta()).toMatchObject({ followersCount: 12 });
		});

		test('ignores an invalid payload', async () => {
			await expect(remoteActorRefreshTask.run(makeTaskRequest({}))).resolves.toBeUndefined();
		});
	});

	describe('remoteActorRefreshTaskId', () => {
		test('is the same within a day and differs across days and actors', () => {
			const day = new Date('2026-10-09T01:00:00Z');
			const sameDay = new Date('2026-10-09T23:00:00Z');
			const nextDay = new Date('2026-10-10T00:00:00Z');
			expect(remoteActorRefreshTaskId(carolIri, day)).toBe(
				remoteActorRefreshTaskId(carolIri, sameDay),
			);
			expect(remoteActorRefreshTaskId(carolIri, day)).not.toBe(
				remoteActorRefreshTaskId(carolIri, nextDay),
			);
			expect(remoteActorRefreshTaskId(carolIri, day)).not.toBe(
				remoteActorRefreshTaskId(`${carolIri}2`, day),
			);
			expect(remoteActorRefreshTaskId(carolIri, day)).toMatch(/^[\w-]{1,500}$/u);
		});
	});

	describe('Account entity', () => {
		const getCarolAccount = async () => {
			const id = await getOrAssignMastodonId(carolIri, undefined);
			return request(mastodon).get(`/api/v1/accounts/${id}`);
		};

		test('shows the fetched counts and the registration date from published', async () => {
			await apex.store.saveObject({
				id: `${carolIri}/statuses/1`,
				type: 'Note',
				attributedTo: carolIri,
				content: 'hello',
				published: '2026-09-30T23:00:00Z',
				to: [PUBLIC],
			} as unknown as APObject);
			await refreshRemoteActorCounts(carolIri);

			const res = await getCarolAccount();
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				acct: `carol@${new URL(origin).host}`,
				followers_count: 12,
				following_count: 34,
				statuses_count: 56,
				created_at: '2020-05-06T00:00:00.000Z',
				last_status_at: '2026-09-30',
			});
		});

		test('falls back to zero counts before the counts are fetched', async () => {
			const res = await getCarolAccount();
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({
				followers_count: 0,
				following_count: 0,
				statuses_count: 0,
				created_at: '2020-05-06T00:00:00.000Z',
				last_status_at: '',
			});
		});

		test('falls back to the fixed registration date when published is missing', async () => {
			const carol = (await apex.store.getObject(carolIri)) as APObject;
			await apex.store.updateObject(omit(carol, 'published') as APObject, null, true);
			const res = await getCarolAccount();
			expect(res.body.created_at).toBe('2021-01-01T00:00:00.000Z');
		});

		test('shows the counts in accounts built in bulk', async () => {
			await refreshRemoteActorCounts(carolIri);
			const accounts = await userIdsToAccountsMap([carolIri]);
			expect(accounts.get(carolIri)).toMatchObject({ followers_count: 12, statuses_count: 56 });
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('reflects updated avatar and display_name in Account response', async () => {
			handler = (req, res) => {
				const path = new URL(req.url ?? '/', origin).pathname;
				if (path === '/users/carol') {
					json(
						res,
						carolObject({
							name: 'Carol Danvers',
							icon: {
								type: 'Image',
								url: 'https://example.com/carol-new-avatar.png',
							},
						}),
					);
					return true;
				}
				return false;
			};

			await refreshRemoteActorCounts(carolIri);

			const res = await getCarolAccount();
			expect(res.status).toBe(200);
			expect(res.body.display_name).toBe('Carol Danvers');
			expect(res.body.avatar).toBe('https://example.com/carol-new-avatar.png');
		});
	});

	describe('requesting a refresh', () => {
		test('GET /api/v1/accounts/:id enqueues a refresh when the counts have never been fetched', async () => {
			const id = await getOrAssignMastodonId(carolIri, undefined);
			await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(enqueueSpy).toHaveBeenCalledWith(carolIri);
		});

		test('GET /api/v1/accounts/:id does not enqueue while the counts are fresh', async () => {
			await refreshRemoteActorCounts(carolIri);
			const id = await getOrAssignMastodonId(carolIri, undefined);
			await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('GET /api/v1/accounts/:id enqueues again once the counts get stale', async () => {
			await refreshRemoteActorCounts(
				carolIri,
				new Date(Date.now() - REMOTE_ACTOR_COUNTS_TTL_MS - 1000),
			);
			const id = await getOrAssignMastodonId(carolIri, undefined);
			await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(enqueueSpy).toHaveBeenCalledWith(carolIri);
		});

		test('GET /api/v1/accounts/lookup enqueues a refresh for remote accounts', async () => {
			const res = await request(mastodon)
				.get('/api/v1/accounts/lookup')
				.query({ acct: `carol@${new URL(origin).host}` });
			expect(res.status).toBe(200);
			expect(enqueueSpy).toHaveBeenCalledWith(carolIri);
		});

		test('does not enqueue for local accounts', async () => {
			await request(mastodon).get('/api/v1/accounts/1');
			await request(mastodon).get('/api/v1/accounts/lookup').query({ acct: 'hakatashi' });
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('responds normally even if the enqueue fails', async () => {
			enqueueSpy.mockRejectedValue(new Error('Cloud Tasks unavailable'));
			const id = await getOrAssignMastodonId(carolIri, undefined);
			const res = await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(res.status).toBe(200);
		});

		test('treats a duplicated task as already requested', async () => {
			enqueueSpy.mockRejectedValue(
				Object.assign(new Error('exists'), { code: 'functions/task-already-exists' }),
			);
			const id = await getOrAssignMastodonId(carolIri, undefined);
			const res = await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(res.status).toBe(200);
		});
	});
});
