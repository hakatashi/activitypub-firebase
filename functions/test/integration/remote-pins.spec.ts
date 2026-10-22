import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import type { APObject } from '../../src/apex/index.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { Objects, UserInfos } from '../../src/schema.js';
import {
	REMOTE_ACTOR_COUNTS_TTL_MS,
	remoteActorRefreshQueue,
	remoteActorRefreshTaskId,
} from '../../src/social/remoteActorCounts.js';
import { remoteOutboxBackfillQueue } from '../../src/social/remoteOutbox.js';
import {
	REMOTE_PINS_MAX_ITEMS,
	handleRemotePinActivity,
	remoteFeaturedSyncQueue,
	syncRemoteFeatured,
} from '../../src/social/remotePins.js';
import { remoteActorRefreshTask } from '../../src/tasks.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

type Handler = (req: IncomingMessage, res: ServerResponse) => boolean;

const makeTaskRequest = (data: unknown) =>
	({ data }) as unknown as Parameters<typeof remoteActorRefreshTask.run>[0];

// inbox-dedup.spec.ts と同じ理由(Cloud Functions ランタイムの req.rawBody 前提の再現)。
const wrapWithRawBody = (target: unknown) => {
	const wrapper = express();
	wrapper.use(
		express.raw({ type: () => true, limit: '10mb' }),
		(req, res, next) => {
			(req as { rawBody?: unknown }).rawBody = req.body;
			req.body = (req.body as Buffer).toString('utf-8');
			next();
		},
		target as unknown as express.RequestHandler,
	);
	return wrapper;
};

describe('remote pinned statuses (Issue #318)', () => {
	let server: Server;
	let origin: string;
	let handler: Handler | undefined;
	let carolIri: string;
	let featuredIri: string;
	let requestedPaths: string[];
	let featuredItems: unknown[];
	let enqueueSpy: MockInstance<typeof remoteFeaturedSyncQueue.enqueue>;

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

	const defaultHandler = (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '/', origin);
		requestedPaths.push(url.pathname);
		if (url.pathname === '/users/carol/collections/featured') {
			json(res, {
				'@context': AS_CONTEXT,
				id: featuredIri,
				type: 'OrderedCollection',
				totalItems: featuredItems.length,
				orderedItems: featuredItems,
			});
			return;
		}
		const match = /^\/users\/carol\/statuses\/(?<n>\d+)$/u.exec(url.pathname);
		if (match !== null) {
			json(res, { '@context': AS_CONTEXT, ...note(Number(match.groups?.n)) });
			return;
		}
		// 別人の投稿 (同じオリジン)。
		if (url.pathname === '/users/dave/statuses/1') {
			json(res, {
				'@context': AS_CONTEXT,
				...note(1, { id: `${origin}/users/dave/statuses/1`, attributedTo: `${origin}/users/dave` }),
			});
			return;
		}
		res.writeHead(404);
		res.end();
	};

	// apex は Mastodon の `featured` を `toot:featured` に圧縮して保存する。
	const saveCarol = () =>
		apex.store.saveObject({
			id: carolIri,
			type: 'Person',
			preferredUsername: 'carol',
			inbox: `${carolIri}/inbox`,
			outbox: `${carolIri}/outbox`,
			followers: `${carolIri}/followers`,
			following: `${carolIri}/following`,
			'toot:featured': [{ id: featuredIri }],
		} as unknown as APObject);

	const getCarol = async () => {
		const carol = await apex.store.getObject(carolIri, true);
		if (carol === undefined) {
			throw new Error('carol is not saved');
		}
		return carol;
	};

	const pinnedIris = async () => {
		const snap = await UserInfos.doc(escapeFirestoreKey(carolIri))
			.collection('pins')
			.orderBy('createdAt', 'desc')
			.get();
		return snap.docs.map((doc) => doc.get('noteIri') as string);
	};

	const pinActivity = (type: 'Add' | 'Remove', object: unknown, target: unknown = featuredIri) =>
		({
			id: `${carolIri}#${type}-${Math.random()}`,
			type,
			actor: carolIri,
			object,
			target,
		}) as unknown as APObject;

	const pinnedContents = async () => {
		const id = await getOrAssignMastodonId(carolIri, undefined);
		const res = await request(mastodon).get(`/api/v1/accounts/${id}/statuses?pinned=true`);
		expect(res.status).toBe(200);
		return res.body.map((status: { content: string }) => status.content) as string[];
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
		featuredIri = `${carolIri}/collections/featured`;
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
		featuredItems = [note(3), `${carolIri}/statuses/1`];
		enqueueSpy = vi.spyOn(remoteFeaturedSyncQueue, 'enqueue').mockResolvedValue(undefined);
		vi.spyOn(remoteActorRefreshQueue, 'enqueue').mockResolvedValue(undefined);
		vi.spyOn(remoteOutboxBackfillQueue, 'enqueue').mockResolvedValue(undefined);
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
		await saveCarol();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('handleRemotePinActivity', () => {
		test('pins the sender’s own note added to its featured collection', async () => {
			await handleRemotePinActivity(await getCarol(), pinActivity('Add', `${carolIri}/statuses/2`));

			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/2`]);
			expect(await apex.store.getObject(`${carolIri}/statuses/2`)).toMatchObject({
				content: ['post 2'],
			});
			expect(await pinnedContents()).toEqual([expect.stringContaining('post 2')]);
		});

		test('fetches the note by IRI instead of trusting an embedded copy', async () => {
			await handleRemotePinActivity(
				await getCarol(),
				pinActivity('Add', note(2, { content: 'forged' })),
			);

			expect(requestedPaths).toContain('/users/carol/statuses/2');
			expect(await apex.store.getObject(`${carolIri}/statuses/2`)).toMatchObject({
				content: ['post 2'],
			});
		});

		test('ignores Add whose target is not the sender’s featured collection', async () => {
			for (const target of [`${carolIri}/collections/other`, `${origin}/users/dave/featured`]) {
				await handleRemotePinActivity(
					await getCarol(),
					pinActivity('Add', `${carolIri}/statuses/2`, target),
				);
			}
			await handleRemotePinActivity(await getCarol(), {
				...pinActivity('Add', `${carolIri}/statuses/2`),
				target: undefined,
			});

			expect(await pinnedIris()).toEqual([]);
			expect(requestedPaths).toEqual([]);
		});

		test('ignores Add of someone else’s note', async () => {
			// 別オリジンの投稿は取得もしない。
			await handleRemotePinActivity(
				await getCarol(),
				pinActivity('Add', 'https://other.example/users/eve/statuses/1'),
			);
			// 同じオリジンでも作者が違えば扱わない。
			await handleRemotePinActivity(
				await getCarol(),
				pinActivity('Add', `${origin}/users/dave/statuses/1`),
			);

			expect(await pinnedIris()).toEqual([]);
			expect(requestedPaths).toEqual(['/users/dave/statuses/1']);
		});

		test('ignores featured hashtags', async () => {
			await handleRemotePinActivity(
				await getCarol(),
				pinActivity('Add', { type: 'Hashtag', href: `${carolIri}/tags/foo`, name: '#foo' }),
			);

			expect(await pinnedIris()).toEqual([]);
		});

		test('removes the pin on Remove only when the target is the sender’s featured collection', async () => {
			await syncRemoteFeatured(carolIri);
			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/3`, `${carolIri}/statuses/1`]);

			await handleRemotePinActivity(
				await getCarol(),
				pinActivity('Remove', `${carolIri}/statuses/3`, `${carolIri}/collections/other`),
			);
			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/3`, `${carolIri}/statuses/1`]);

			await handleRemotePinActivity(
				await getCarol(),
				pinActivity('Remove', `${carolIri}/statuses/3`),
			);
			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/1`]);
		});

		test(`ignores Add beyond ${REMOTE_PINS_MAX_ITEMS} pins`, async () => {
			const pins = UserInfos.doc(escapeFirestoreKey(carolIri)).collection('pins');
			for (let n = 0; n < REMOTE_PINS_MAX_ITEMS; n++) {
				const iri = `${carolIri}/statuses/${100 + n}`;
				await pins.doc(escapeFirestoreKey(iri)).set({ noteIri: iri, createdAt: new Date() });
			}

			await handleRemotePinActivity(await getCarol(), pinActivity('Add', `${carolIri}/statuses/2`));

			expect(await pinnedIris()).not.toContain(`${carolIri}/statuses/2`);
		});
	});

	describe('inbox', () => {
		let originalEnv: string;

		beforeEach(async () => {
			const actor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
			await apex.store.saveObject(actor);
			// security.verifySignature は development env でのみ Signature ヘッダなしを許す。
			originalEnv = app.get('env') as string;
			app.set('env', 'development');
		});

		afterEach(() => {
			app.set('env', originalEnv);
		});

		const postToInbox = (activity: Record<string, unknown>) =>
			request(wrapWithRawBody(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', 'application/activity+json')
				.send(JSON.stringify({ '@context': AS_CONTEXT, actor: carolIri, ...activity }));

		test('accepts Add / Remove of a Note and updates the pins', async () => {
			const added = await postToInbox({
				id: `${carolIri}#add-1`,
				type: 'Add',
				object: `${carolIri}/statuses/2`,
				target: featuredIri,
			});
			expect(added.status).toBe(200);
			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/2`]);

			const removed = await postToInbox({
				id: `${carolIri}#remove-1`,
				type: 'Remove',
				object: `${carolIri}/statuses/2`,
				target: featuredIri,
			});
			expect(removed.status).toBe(200);
			expect(await pinnedIris()).toEqual([]);
		});

		test('rejects Add without an object', async () => {
			const res = await postToInbox({ id: `${carolIri}#add-2`, type: 'Add', target: featuredIri });
			expect(res.status).toBe(400);
		});
	});

	describe('syncRemoteFeatured', () => {
		test('replaces the pins with the featured collection in order and records the fetch time', async () => {
			const stale = `${carolIri}/statuses/5`;
			await UserInfos.doc(escapeFirestoreKey(carolIri))
				.collection('pins')
				.doc(escapeFirestoreKey(stale))
				.set({ noteIri: stale, createdAt: new Date() });

			const now = new Date('2026-10-22T00:00:00.000Z');
			await syncRemoteFeatured(carolIri, now);

			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/3`, `${carolIri}/statuses/1`]);
			// 埋め込みの Note は取得しない。
			expect(requestedPaths).toEqual([
				'/users/carol/collections/featured',
				'/users/carol/statuses/1',
			]);
			expect((await getCarol())._meta).toMatchObject({ featuredFetchedAt: now.toISOString() });
			expect(await pinnedContents()).toEqual([
				expect.stringContaining('post 3'),
				expect.stringContaining('post 1'),
			]);
		});

		test('skips items that are not the actor’s own notes', async () => {
			featuredItems = [
				note(3, { attributedTo: `${origin}/users/dave` }),
				`${origin}/users/dave/statuses/1`,
				'https://other.example/users/carol/statuses/1',
				note(2),
			];
			await syncRemoteFeatured(carolIri);

			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/2`]);
			expect(await apex.store.getObject(`${carolIri}/statuses/3`)).toBeUndefined();
		});

		test('keeps the pins when the collection cannot be fetched', async () => {
			await syncRemoteFeatured(carolIri);
			handler = (_req, res) => {
				res.writeHead(500);
				res.end();
				return true;
			};
			const now = new Date('2026-10-23T00:00:00.000Z');
			await syncRemoteFeatured(carolIri, now);

			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/3`, `${carolIri}/statuses/1`]);
			expect((await getCarol())._meta).toMatchObject({ featuredFetchedAt: now.toISOString() });
		});

		test('runs from remoteActorRefreshTask with kind featured', async () => {
			await remoteActorRefreshTask.run(makeTaskRequest({ actorIri: carolIri, kind: 'featured' }));

			expect(await pinnedIris()).toEqual([`${carolIri}/statuses/3`, `${carolIri}/statuses/1`]);
		});
	});

	describe('requesting the sync on profile view', () => {
		test('enqueues the sync when the remote account is viewed and the pins are stale', async () => {
			const id = await getOrAssignMastodonId(carolIri, undefined);
			const res = await request(mastodon).get(`/api/v1/accounts/${id}`);

			expect(res.status).toBe(200);
			expect(enqueueSpy).toHaveBeenCalledWith(carolIri);
		});

		test('does not enqueue the sync while fresh, and enqueues again once stale', async () => {
			await syncRemoteFeatured(carolIri);
			const id = await getOrAssignMastodonId(carolIri, undefined);
			await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(enqueueSpy).not.toHaveBeenCalled();

			await syncRemoteFeatured(carolIri, new Date(Date.now() - REMOTE_ACTOR_COUNTS_TTL_MS - 1000));
			await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(enqueueSpy).toHaveBeenCalledWith(carolIri);
		});

		test('does not enqueue the sync for actors without featured', async () => {
			await Objects.doc(escapeFirestoreKey(carolIri)).update({
				'toot:featured': FieldValue.delete(),
			});
			const id = await getOrAssignMastodonId(carolIri, undefined);
			await request(mastodon).get(`/api/v1/accounts/${id}`);
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('uses a separate task id per kind', () => {
			const now = new Date('2026-10-22T00:00:00.000Z');
			expect(remoteActorRefreshTaskId(carolIri, now, 'featured')).toMatch(
				/^remote-actor-featured-[0-9a-f]{32}-20261022$/u,
			);
		});
	});
});
