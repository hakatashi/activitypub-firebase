import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import type { APObject } from '../../src/apex/index.js';
import { domain } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { userIdsToAccountsMap } from '../../src/mastodon/presenters/account.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { remoteActorRefreshTaskId } from '../../src/social/remoteActorCounts.js';
import {
	MAX_RESOLUTION_REQUESTS_PER_CALL,
	clearRequestedRemoteActorResolutions,
	remoteActorResolutionQueue,
	requestRemoteActorResolution,
	requestResolutionOfObjectActors,
	resolveMissingRemoteActor,
} from '../../src/social/remoteActorResolution.js';
import { remoteActorRefreshTask } from '../../src/tasks.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const LOCAL_ORIGIN = `https://${domain}`;

const makeTaskRequest = (data: unknown) =>
	({ data }) as unknown as Parameters<typeof remoteActorRefreshTask.run>[0];

describe('resolving missing remote actors (Issue #244)', () => {
	let server: Server;
	let origin: string;
	let daveIri: string;
	let erinIri: string;
	let serverDown = false;
	let requestedPaths: string[] = [];
	let enqueueSpy: MockInstance<typeof remoteActorResolutionQueue.enqueue>;

	const personOf = (name: string) => ({
		'@context': AS_CONTEXT,
		id: `${origin}/users/${name}`,
		type: 'Person',
		preferredUsername: name,
		name: name.toUpperCase(),
		inbox: `${origin}/users/${name}/inbox`,
		outbox: `${origin}/users/${name}/outbox`,
		followers: `${origin}/users/${name}/followers`,
		following: `${origin}/users/${name}/following`,
	});

	const saveNote = (id: string, attributedTo: string, extra: Record<string, unknown> = {}) =>
		apex.store.saveObject({
			id,
			type: 'Note',
			attributedTo,
			content: 'hello',
			published: '2026-10-01T00:00:00Z',
			to: [PUBLIC],
			...extra,
		} as unknown as APObject);

	beforeAll(async () => {
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const path = new URL(req.url ?? '/', origin).pathname;
			requestedPaths.push(path);
			if (serverDown) {
				req.socket.destroy();
				return;
			}
			const match = /^\/users\/(?<name>dave|erin)$/u.exec(path);
			if (match?.groups?.name !== undefined) {
				res.writeHead(200, { 'content-type': 'application/activity+json' });
				res.end(JSON.stringify(personOf(match.groups.name)));
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		daveIri = `${origin}/users/dave`;
		erinIri = `${origin}/users/erin`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});

	beforeEach(async () => {
		await resetFirestore();
		clearRequestedRemoteActorResolutions();
		serverDown = false;
		requestedPaths = [];
		enqueueSpy = vi.spyOn(remoteActorResolutionQueue, 'enqueue').mockResolvedValue(undefined);
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('resolveMissingRemoteActor', () => {
		test('fetches and stores the actor', async () => {
			await resolveMissingRemoteActor(daveIri);
			expect(await apex.store.getObject(daveIri)).toMatchObject({ id: daveIri });
		});

		test('does nothing when the actor is already stored', async () => {
			await apex.store.saveObject(personOf('dave') as unknown as APObject);
			await resolveMissingRemoteActor(daveIri);
			expect(requestedPaths).toEqual([]);
		});

		test('does not throw when the remote server is down', async () => {
			serverDown = true;
			await expect(resolveMissingRemoteActor(daveIri)).resolves.toBeUndefined();
			expect(await apex.store.getObject(daveIri)).toBeUndefined();
		});

		test('does not fetch local IRIs', async () => {
			const requestSpy = vi.spyOn(apex, 'requestObject');
			await resolveMissingRemoteActor(`${LOCAL_ORIGIN}/activitypub/u/nobody`);
			expect(requestSpy).not.toHaveBeenCalled();
		});
	});

	describe('remoteActorRefreshTask', () => {
		test('resolves the actor with kind "resolve"', async () => {
			await remoteActorRefreshTask.run(makeTaskRequest({ actorIri: daveIri, kind: 'resolve' }));
			expect(await apex.store.getObject(daveIri)).toMatchObject({ id: daveIri });
			// 件数は取らない
			expect(requestedPaths).not.toContain('/users/dave/followers');
		});

		test('ignores an unknown kind', async () => {
			await remoteActorRefreshTask.run(makeTaskRequest({ actorIri: daveIri, kind: 'unknown' }));
			expect(requestedPaths).toEqual([]);
		});
	});

	describe('requestRemoteActorResolution', () => {
		test('enqueues with a daily task ID distinct from the counts refresh', async () => {
			const now = new Date('2026-10-09T00:00:00Z');
			await requestRemoteActorResolution([daveIri], now);
			const taskId = remoteActorRefreshTaskId(daveIri, now, 'resolve');
			expect(enqueueSpy).toHaveBeenCalledWith(daveIri, taskId);
			expect(taskId).not.toBe(remoteActorRefreshTaskId(daveIri, now));
			expect(taskId).toMatch(/^[\w-]{1,500}$/u);
		});

		test('skips local and invalid IRIs', async () => {
			await requestRemoteActorResolution([`${LOCAL_ORIGIN}/activitypub/u/nobody`, 'not a url']);
			expect(enqueueSpy).not.toHaveBeenCalled();
		});

		test('limits the number of requests per call', async () => {
			const iris = Array.from({ length: 15 }, (_, i) => `${origin}/users/u${i}`);
			await requestRemoteActorResolution(iris);
			expect(enqueueSpy).toHaveBeenCalledTimes(MAX_RESOLUTION_REQUESTS_PER_CALL);
		});

		test('does not enqueue the same actor twice on the same day', async () => {
			await requestRemoteActorResolution([daveIri]);
			await requestRemoteActorResolution([daveIri]);
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});

		test('treats a duplicated task as already requested', async () => {
			enqueueSpy.mockRejectedValueOnce(
				Object.assign(new Error('exists'), { code: 'functions/task-already-exists' }),
			);
			await requestRemoteActorResolution([daveIri]);
			await requestRemoteActorResolution([daveIri]);
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});

		test('does not throw and retries later when the enqueue fails', async () => {
			enqueueSpy.mockRejectedValueOnce(new Error('Cloud Tasks unavailable'));
			await expect(requestRemoteActorResolution([daveIri])).resolves.toBeUndefined();
			await requestRemoteActorResolution([daveIri]);
			expect(enqueueSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe('building accounts', () => {
		test('userIdsToAccountsMap requests only the missing remote actors', async () => {
			await apex.store.saveObject(personOf('erin') as unknown as APObject);
			const accounts = await userIdsToAccountsMap([
				daveIri,
				erinIri,
				`${LOCAL_ORIGIN}/activitypub/u/hakatashi`,
			]);
			expect([...accounts.keys()].sort()).toEqual(
				[`${LOCAL_ORIGIN}/activitypub/u/hakatashi`, erinIri].sort(),
			);
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
			expect(enqueueSpy).toHaveBeenCalledWith(daveIri, expect.any(String));
		});

		test('GET /api/v1/statuses/:id requests the missing author of the replied note', async () => {
			await apex.store.saveObject(personOf('erin') as unknown as APObject);
			const parentIri = `${daveIri}/statuses/1`;
			const replyIri = `${erinIri}/statuses/2`;
			await saveNote(parentIri, daveIri);
			await saveNote(replyIri, erinIri, { inReplyTo: parentIri });

			const id = await getOrAssignMastodonId(replyIri, '2026-10-01T00:00:00Z');
			const res = await request(mastodon).get(`/api/v1/statuses/${id}`);
			expect(res.status).toBe(200);
			expect(res.body.in_reply_to_account_id).toBeNull();
			expect(enqueueSpy).toHaveBeenCalledWith(daveIri, expect.any(String));

			// タスクで取得した後は、リプライ先のアカウントが分かる
			await resolveMissingRemoteActor(daveIri);
			const res2 = await request(mastodon).get(`/api/v1/statuses/${id}`);
			expect(res2.body.in_reply_to_account_id).toEqual(expect.any(String));
		});
	});

	describe('requestResolutionOfObjectActors', () => {
		test('requests the missing author of the object and of the replied note', async () => {
			const parentIri = `${erinIri}/statuses/1`;
			await saveNote(parentIri, erinIri);
			await requestResolutionOfObjectActors({
				id: `${daveIri}/statuses/2`,
				type: 'Note',
				attributedTo: daveIri,
				inReplyTo: parentIri,
			} as unknown as APObject);
			expect(enqueueSpy.mock.calls.map(([iri]) => iri).sort()).toEqual([daveIri, erinIri].sort());
		});

		test('does not request actors that are already stored', async () => {
			await apex.store.saveObject(personOf('dave') as unknown as APObject);
			await requestResolutionOfObjectActors({
				id: `${daveIri}/statuses/2`,
				type: 'Note',
				attributedTo: daveIri,
			} as unknown as APObject);
			expect(enqueueSpy).not.toHaveBeenCalled();
		});
	});

	describe('inbox', () => {
		const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';
		let originalEnv: string;

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

		beforeEach(async () => {
			await resetFirestore();
			const actor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
			await apex.store.saveObject(actor);
			await apex.store.saveObject({
				id: REMOTE_ACTOR_ID,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${REMOTE_ACTOR_ID}/inbox`,
				outbox: `${REMOTE_ACTOR_ID}/outbox`,
			});
			vi.spyOn(apex, 'resolveActivity').mockResolvedValue(undefined);
			vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
			// security.verifySignature は development env でのみ Signature ヘッダなしを許す。
			originalEnv = app.get('env') as string;
			app.set('env', 'development');
		});

		afterEach(() => {
			app.set('env', originalEnv);
		});

		test('an Announce of a note by a missing author requests the author', async () => {
			const noteIri = `${daveIri}/statuses/1`;
			await saveNote(noteIri, daveIri);

			const response = await request(wrapWithRawBody(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', 'application/activity+json')
				.send(
					JSON.stringify({
						'@context': AS_CONTEXT,
						id: 'https://remote.example/activities/announce-1',
						type: 'Announce',
						actor: REMOTE_ACTOR_ID,
						to: 'as:Public',
						object: noteIri,
					}),
				);

			expect(response.status).toBe(200);
			expect(enqueueSpy).toHaveBeenCalledWith(daveIri, expect.any(String));
		});
	});
});
