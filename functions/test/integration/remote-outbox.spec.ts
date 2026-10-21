import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { apex } from '../../src/apex.js';
import type { APObject } from '../../src/apex/index.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { HomeFeed, Notifications } from '../../src/schema.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import {
	REMOTE_ACTOR_COUNTS_TTL_MS,
	remoteActorRefreshQueue,
	remoteActorRefreshTaskId,
} from '../../src/social/remoteActorCounts.js';
import {
	OUTBOX_MAX_REQUESTS,
	backfillRemoteOutbox,
	remoteOutboxBackfillQueue,
} from '../../src/social/remoteOutbox.js';
import { remoteActorRefreshTask } from '../../src/tasks.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const LOCAL_ACTOR = 'https://example.com/activitypub/u/hakatashi';

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const makeTaskRequest = (data: unknown) =>
	({ data }) as unknown as Parameters<typeof remoteActorRefreshTask.run>[0];

describe('remote outbox backfill (Issue #320)', () => {
	let server: Server;
	let origin: string;
	let handler: Handler | undefined;
	let carolIri: string;
	let requestedPaths: string[];
	let enqueueSpy: MockInstance<typeof remoteOutboxBackfillQueue.enqueue>;

	const json = (res: ServerResponse, body: unknown) => {
		res.writeHead(200, { 'content-type': 'application/activity+json' });
		res.end(JSON.stringify(body));
	};

	const note = (n: number, extra: Record<string, unknown> = {}) => ({
		id: `${carolIri}/statuses/${n}`,
		type: 'Note',
		attributedTo: carolIri,
		content: `post ${n}`,
		published: `2026-09-${String(n).padStart(2, '0')}T10:00:00Z`,
		to: [PUBLIC],
		cc: [`${carolIri}/followers`],
		...extra,
	});

	const create = (object: unknown, extra: Record<string, unknown> = {}) => ({
		id: `${typeof object === 'string' ? object : (object as { id: string }).id}/activity`,
		type: 'Create',
		actor: carolIri,
		object,
		...extra,
	});

	// 既定の outbox: 1 ページ目に Note 3・2、2 ページ目に Note 1、3 ページ目に Note 0 (辿らない)。
	let pages: Record<string, unknown[]>;

	const outboxPage = (n: number) => ({
		'@context': AS_CONTEXT,
		id: `${carolIri}/outbox?page=${n}`,
		type: 'OrderedCollectionPage',
		partOf: `${carolIri}/outbox`,
		orderedItems: pages[String(n)] ?? [],
		...(pages[String(n + 1)] === undefined ? {} : { next: `${carolIri}/outbox?page=${n + 1}` }),
	});

	const defaultHandler = (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '/', origin);
		requestedPaths.push(`${url.pathname}${url.search}`);
		if (url.pathname === '/users/carol/outbox') {
			const page = url.searchParams.get('page');
			if (page === null) {
				json(res, {
					'@context': AS_CONTEXT,
					id: `${carolIri}/outbox`,
					type: 'OrderedCollection',
					totalItems: 4,
					first: `${carolIri}/outbox?page=1`,
				});
				return;
			}
			json(res, outboxPage(Number(page)));
			return;
		}
		const match = /^\/users\/carol\/statuses\/(?<n>\d+)$/u.exec(url.pathname);
		if (match !== null) {
			json(res, { '@context': AS_CONTEXT, ...note(Number(match.groups?.n)) });
			return;
		}
		res.writeHead(404);
		res.end();
	};

	const saveCarol = () =>
		apex.store.saveObject({
			id: carolIri,
			type: 'Person',
			preferredUsername: 'carol',
			inbox: `${carolIri}/inbox`,
			outbox: `${carolIri}/outbox`,
			followers: `${carolIri}/followers`,
			following: `${carolIri}/following`,
		} as unknown as APObject);

	const storedNoteIds = async () => {
		const ids: string[] = [];
		for (const n of [0, 1, 2, 3, 4, 5]) {
			if ((await apex.store.getObject(`${carolIri}/statuses/${n}`)) !== undefined) {
				ids.push(String(n));
			}
		}
		return ids;
	};

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
		requestedPaths = [];
		pages = {
			'1': [create(note(3)), create(note(2))],
			'2': [create(note(1))],
			'3': [create(note(0))],
		};
		enqueueSpy = vi.spyOn(remoteOutboxBackfillQueue, 'enqueue').mockResolvedValue(undefined);
		vi.spyOn(remoteActorRefreshQueue, 'enqueue').mockResolvedValue(undefined);
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
		await saveCarol();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('backfillRemoteOutbox', () => {
		test('saves public notes from the first two pages and records the fetch time', async () => {
			const now = new Date('2026-10-22T00:00:00.000Z');
			await backfillRemoteOutbox(carolIri, now);

			expect(await storedNoteIds()).toEqual(['1', '2', '3']);
			const saved = await apex.store.getObject(`${carolIri}/statuses/3`);
			expect(saved).toMatchObject({ content: ['post 3'] });
			expect((await apex.store.getObject(carolIri, true))?._meta).toMatchObject({
				outboxFetchedAt: now.toISOString(),
			});
		});

		test('shows the backfilled notes in the account statuses', async () => {
			await backfillRemoteOutbox(carolIri);

			const id = await getOrAssignMastodonId(carolIri, undefined);
			const res = await request(mastodon).get(`/api/v1/accounts/${id}/statuses`);
			expect(res.status).toBe(200);
			expect(res.body.map((status: { content: string }) => status.content)).toEqual([
				expect.stringContaining('post 3'),
				expect.stringContaining('post 2'),
				expect.stringContaining('post 1'),
			]);
		});

		test('fetches objects given only by IRI', async () => {
			pages = { '1': [create(`${carolIri}/statuses/4`)] };
			await backfillRemoteOutbox(carolIri);

			expect(await storedNoteIds()).toEqual(['4']);
			expect(requestedPaths).toContain('/users/carol/statuses/4');
		});

		test('skips non-public notes, other authors, other origins and non-Create items', async () => {
			pages = {
				'1': [
					create(note(1, { to: [`${carolIri}/followers`], cc: [] })),
					create(note(2, { attributedTo: 'https://other.example/users/dave' })),
					create(note(3, { id: 'https://other.example/statuses/3' })),
					create(note(4), { actor: 'https://other.example/users/dave' }),
					{
						id: `${carolIri}/statuses/5/announce`,
						type: 'Announce',
						actor: carolIri,
						object: note(5),
					},
				],
			};
			await backfillRemoteOutbox(carolIri);

			expect(await storedNoteIds()).toEqual([]);
			expect(await apex.store.getObject('https://other.example/statuses/3')).toBeUndefined();
		});

		test('saves unlisted notes', async () => {
			pages = { '1': [create(note(1, { to: [`${carolIri}/followers`], cc: [PUBLIC] }))] };
			await backfillRemoteOutbox(carolIri);
			expect(await storedNoteIds()).toEqual(['1']);
		});

		test('does not overwrite notes that are already stored', async () => {
			await apex.store.saveObject({ ...note(3), content: 'edited' } as unknown as APObject);
			await backfillRemoteOutbox(carolIri);

			expect(await apex.store.getObject(`${carolIri}/statuses/3`)).toMatchObject({
				content: 'edited',
			});
			expect(await storedNoteIds()).toEqual(['1', '2', '3']);
		});

		test('does not create notifications for backfilled mentions', async () => {
			pages = {
				'1': [
					create(
						note(1, {
							to: [PUBLIC, LOCAL_ACTOR],
							tag: [{ type: 'Mention', href: LOCAL_ACTOR, name: '@hakatashi' }],
						}),
					),
				],
			};
			await backfillRemoteOutbox(carolIri);

			expect(await storedNoteIds()).toEqual(['1']);
			const notifications = await Notifications(escapeFirestoreKey(LOCAL_ACTOR)).get();
			expect(notifications.empty).toBe(true);
			const homeFeed = await HomeFeed(escapeFirestoreKey(LOCAL_ACTOR)).get();
			expect(homeFeed.empty).toBe(true);
		});

		test('limits the number of requests to the remote server', async () => {
			pages = {
				'1': Array.from({ length: 20 }, (_, i) => create(`${carolIri}/statuses/${i + 10}`)),
			};
			await backfillRemoteOutbox(carolIri);

			expect(requestedPaths).toHaveLength(OUTBOX_MAX_REQUESTS);
		});

		test('records the fetch time without saving anything when the outbox cannot be fetched', async () => {
			handler = (req, res) => {
				res.writeHead(401);
				res.end();
				return true;
			};
			const now = new Date('2026-10-22T00:00:00.000Z');
			await backfillRemoteOutbox(carolIri, now);

			expect(await storedNoteIds()).toEqual([]);
			expect((await apex.store.getObject(carolIri, true))?._meta).toMatchObject({
				outboxFetchedAt: now.toISOString(),
			});
		});

		test('does not fetch anything for local actors', async () => {
			const requestSpy = vi.spyOn(apex, 'requestObject');
			await backfillRemoteOutbox(LOCAL_ACTOR);
			expect(requestSpy).not.toHaveBeenCalled();
		});
	});

	describe('remoteActorRefreshTask', () => {
		test('backfills the outbox for kind "outbox"', async () => {
			await remoteActorRefreshTask.run(makeTaskRequest({ actorIri: carolIri, kind: 'outbox' }));
			expect(await storedNoteIds()).toEqual(['1', '2', '3']);
		});
	});

	describe('remoteActorRefreshTaskId', () => {
		test('differs from the counts task on the same day', () => {
			const day = new Date('2026-10-22T01:00:00Z');
			expect(remoteActorRefreshTaskId(carolIri, day, 'outbox')).not.toBe(
				remoteActorRefreshTaskId(carolIri, day),
			);
		});
	});

	describe('requesting a backfill', () => {
		test('GET /api/v1/accounts/:id enqueues a backfill when the outbox has never been fetched', async () => {
			const id = await getOrAssignMastodonId(carolIri, undefined);
			const res = await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(res.status).toBe(200);
			expect(enqueueSpy).toHaveBeenCalledWith(carolIri);
		});

		test('GET /api/v1/accounts/lookup enqueues a backfill for remote accounts', async () => {
			const res = await request(mastodon)
				.get('/api/v1/accounts/lookup')
				.query({ acct: `carol@${new URL(origin).host}` });
			expect(res.status).toBe(200);
			expect(enqueueSpy).toHaveBeenCalledWith(carolIri);
		});

		test('does not enqueue while the outbox is fresh, and enqueues again once stale', async () => {
			await backfillRemoteOutbox(carolIri);
			const id = await getOrAssignMastodonId(carolIri, undefined);
			await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(enqueueSpy).not.toHaveBeenCalled();

			await backfillRemoteOutbox(
				carolIri,
				new Date(Date.now() - REMOTE_ACTOR_COUNTS_TTL_MS - 1000),
			);
			await request(mastodon).get(`/api/v1/accounts/${id}`);
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
	});
});
