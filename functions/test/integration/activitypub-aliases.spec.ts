import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { mastodonApi } from '../../src/mastodon/index.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';
import { addAccessToken } from '../helpers/auth.js';

const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';

describe('ActivityPub aliases (Issue #265)', () => {
	let server: Server;
	let origin: string;
	let host: string;
	let aliceIri: string;
	let bobIri: string;

	const personOf = (name: string) => ({
		'@context': AS_CONTEXT,
		id: `${origin}/users/${name}`,
		type: 'Person',
		preferredUsername: name,
		name: name.toUpperCase(),
		inbox: `${origin}/users/${name}/inbox`,
		outbox: `${origin}/users/${name}/outbox`,
	});

	beforeAll(async () => {
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
				res.writeHead(404);
				res.end();
				return;
			}
			const match = /^\/users\/(?<name>alice|bob)$/u.exec(url.pathname);
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
		const port = (server.address() as AddressInfo).port;
		origin = `http://127.0.0.1:${port}`;
		host = `127.0.0.1:${port}`;
		aliceIri = `${origin}/users/alice`;
		bobIri = `${origin}/users/bob`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});

	const adminHeader = { 'x-hakatashi-token': 'test-token' };

	beforeEach(async () => {
		process.env.HAKATASHI_TOKEN = 'test-token';
		await resetFirestore();
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
	});

	afterEach(async () => {
		delete process.env.HAKATASHI_TOKEN;
		vi.restoreAllMocks();
		await resetFirestore();
	});

	test('GET /activitypub/aliases requires admin token', async () => {
		const res = await request(app).get('/activitypub/aliases');
		expect(res.status).toBe(403);
	});

	test('GET /activitypub/aliases returns empty list initially', async () => {
		const res = await request(app).get('/activitypub/aliases').set(adminHeader);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ aliases: [] });
	});

	test('POST /activitypub/aliases validation failures', async () => {
		const res1 = await request(app).post('/activitypub/aliases').set(adminHeader).send({});
		expect(res1.status).toBe(400);

		const res2 = await request(app)
			.post('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: '' });
		expect(res2.status).toBe(400);

		const res3 = await request(app)
			.post('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: 'invalid-acct' });
		expect(res3.status).toBe(400);

		const res4 = await request(app)
			.post('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: 'unknown@example.com' });
		expect(res4.status).toBe(404);
	});

	test('POST /activitypub/aliases adds alias and publishes update', async () => {
		const publishSpy = vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);

		// 1. Add alias via acct
		const res1 = await request(app)
			.post('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: `alice@${host}` });
		expect(res1.status).toBe(200);
		expect(res1.body).toEqual({
			added: aliceIri,
			aliases: [aliceIri],
		});
		expect(publishSpy).toHaveBeenCalledTimes(1);

		// 2. Add another alias via URL
		const res2 = await request(app)
			.post('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: bobIri });
		expect(res2.status).toBe(200);
		expect(res2.body).toEqual({
			added: bobIri,
			aliases: [aliceIri, bobIri],
		});
		expect(publishSpy).toHaveBeenCalledTimes(2);

		// 3. Adding duplicate is idempotent
		const res3 = await request(app)
			.post('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: `alice@${host}` });
		expect(res3.status).toBe(200);
		expect(res3.body).toEqual({
			added: aliceIri,
			aliases: [aliceIri, bobIri],
		});
		// No extra publishUpdate for duplicate
		expect(publishSpy).toHaveBeenCalledTimes(2);

		// 4. GET /activitypub/aliases returns all aliases
		const listRes = await request(app).get('/activitypub/aliases').set(adminHeader);
		expect(listRes.status).toBe(200);
		expect(listRes.body).toEqual({ aliases: [aliceIri, bobIri] });

		// 5. GET /activitypub/u/hakatashi outputs alsoKnownAs with both content-types
		const actorResJson = await request(app)
			.get('/activitypub/u/hakatashi')
			.set('Accept', 'application/activity+json');
		expect(actorResJson.status).toBe(200);
		expect(actorResJson.body.alsoKnownAs).toEqual([aliceIri, bobIri]);
		expect(actorResJson.body['@context']).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
				}),
			]),
		);

		const actorResLd = await request(app)
			.get('/activitypub/u/hakatashi')
			.set('Accept', 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"');
		expect(actorResLd.status).toBe(200);
		expect(actorResLd.body.alsoKnownAs).toEqual([aliceIri, bobIri]);

		// 6. PATCH /api/v1/accounts/update_credentials preserves alsoKnownAs
		await addAccessToken('valid-token', 'write:accounts', 'uid-hakatashi');
		const updateRes = await request(mastodonApi)
			.patch('/api/v1/accounts/update_credentials')
			.set('Authorization', 'Bearer valid-token')
			.send({ display_name: 'Updated Name' });
		expect(updateRes.status).toBe(200);
		// update_credentials also publishes an Update(Person)
		expect(publishSpy).toHaveBeenCalledTimes(3);

		const actorAfterUpdate = await request(app)
			.get('/activitypub/u/hakatashi')
			.set('Accept', 'application/activity+json');
		expect(actorAfterUpdate.status).toBe(200);
		expect(actorAfterUpdate.body.name).toBe('Updated Name');
		expect(actorAfterUpdate.body.alsoKnownAs).toEqual([aliceIri, bobIri]);

		// 7. DELETE /activitypub/aliases removes alias and publishes update
		const deleteRes1 = await request(app)
			.delete('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: aliceIri });
		expect(deleteRes1.status).toBe(200);
		expect(deleteRes1.body).toEqual({
			removed: aliceIri,
			aliases: [bobIri],
		});
		expect(publishSpy).toHaveBeenCalledTimes(4);

		const deleteRes2 = await request(app)
			.delete('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: bobIri });
		expect(deleteRes2.status).toBe(200);
		expect(deleteRes2.body).toEqual({
			removed: bobIri,
			aliases: [],
		});
		expect(publishSpy).toHaveBeenCalledTimes(5);

		// 8. Delete nonexistent alias returns 404
		const deleteRes3 = await request(app)
			.delete('/activitypub/aliases')
			.set(adminHeader)
			.send({ alias: aliceIri });
		expect(deleteRes3.status).toBe(404);

		// 9. When empty, alsoKnownAs is removed from actor output
		const actorResEmpty = await request(app)
			.get('/activitypub/u/hakatashi')
			.set('Accept', 'application/activity+json');
		expect(actorResEmpty.status).toBe(200);
		expect(actorResEmpty.body.alsoKnownAs).toBeUndefined();
	});
});
