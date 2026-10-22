import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { localActorIri } from '../../src/localActor.js';
import { Streams, UserInfos } from '../../src/schema.js';
import { reconcilePendingFollows } from '../../src/social/follows.js';
import { toIdArray } from '../../src/utils.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

// dev のインスタンス設定の既定の許可リスト (→ ADR-0148)。
const DEV_HAKATASHI = 'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi';
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';
const adminHeader = { 'x-hakatashi-token': 'test-token' };

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

const sendFollow = (username: string, follower: string, id: string) =>
	request(wrapWithRawBody(activitypub))
		.post(`/activitypub/u/${username}/inbox`)
		.set('Content-Type', 'application/activity+json')
		.send(
			JSON.stringify({
				'@context': 'https://www.w3.org/ns/activitystreams',
				id,
				type: 'Follow',
				actor: follower,
				object: localActorIri(username),
			}),
		);

const getFollowers = async (username: string) => {
	const res = await request(app)
		.get(`/activitypub/u/${username}/followers`)
		.query({ page: 'true' })
		.set('Accept', 'application/activity+json');
	expect(res.status).toBe(200);
	return res.body.orderedItems as string[];
};

const outboxActivities = async (type: string, actor: string) => {
	const docs = await Streams.where('type', '==', type).get();
	return docs.docs.map((doc) => doc.data()).filter((a) => toIdArray(a.actor).includes(actor));
};

describe('bot actors (ADR-0149, ADR-0150)', () => {
	beforeEach(async () => {
		process.env.HAKATASHI_TOKEN = 'test-token';
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
		await apex.store.saveObject({
			id: REMOTE_ACTOR_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE_ACTOR_ID}/inbox`,
			outbox: `${REMOTE_ACTOR_ID}/outbox`,
		});
		// security.verifySignature は development env でのみ Signature ヘッダなしを許す。
		app.set('env', 'development');
	});

	afterEach(async () => {
		delete process.env.HAKATASHI_TOKEN;
		vi.restoreAllMocks();
		await resetFirestore();
	});

	const createBot = (body: Record<string, unknown>) =>
		request(app).post('/activitypub/bots').set(adminHeader).send(body);

	test('creates a Service actor with an allowlist policy by default', async () => {
		const res = await createBot({ username: 'weather', displayName: 'Weather' });
		expect(res.status).toBe(201);
		const actorId = localActorIri('weather');
		expect(res.body).toEqual({
			username: 'weather',
			actor: actorId,
			followPolicy: { mode: 'allowlist', allowlist: [DEV_HAKATASHI] },
		});

		const actor = await apex.store.getObject(actorId, true);
		expect(actor?.type).toBe('Service');
		expect(toIdArray(actor?.name)).toEqual(['Weather']);
		expect(actor?.manuallyApprovesFollowers).toBe(true);
		expect(actor?._meta?.privateKey).toEqual(expect.any(String));

		const userInfo = (await UserInfos.doc(escapeFirestoreKey(actorId)).get()).data();
		expect(userInfo).toMatchObject({
			id: '2',
			uid: null,
			bot: true,
			locked: true,
			source: { privacy: 'private' },
		});

		const list = await request(app).get('/activitypub/bots').set(adminHeader);
		expect(list.body).toEqual([res.body]);
	});

	test('rejects invalid, reserved and duplicate usernames without overwriting keys', async () => {
		expect((await createBot({ username: 'Bad-Name' })).status).toBe(400);
		expect((await createBot({ username: 'hakatashi' })).status).toBe(409);

		expect((await createBot({ username: 'feed' })).status).toBe(201);
		const before = await apex.store.getObject(localActorIri('feed'), true);
		expect((await createBot({ username: 'feed' })).status).toBe(409);
		const after = await apex.store.getObject(localActorIri('feed'), true);
		expect(after?._meta?.privateKey).toBe(before?._meta?.privateKey);
	});

	test('accepts follows from the allowlist and rejects the others', async () => {
		await createBot({ username: 'weather' });

		expect((await sendFollow('weather', DEV_HAKATASHI, `${DEV_HAKATASHI}#follow-1`)).status).toBe(
			200,
		);
		expect(
			(await sendFollow('weather', REMOTE_ACTOR_ID, 'https://remote.example/follows/1')).status,
		).toBe(200);

		expect(await getFollowers('weather')).toEqual([DEV_HAKATASHI]);
		const botId = localActorIri('weather');
		expect((await outboxActivities('Accept', botId)).map((a) => toIdArray(a.to))).toEqual([
			[DEV_HAKATASHI],
		]);
		const rejects = await outboxActivities('Reject', botId);
		expect(rejects.map((a) => toIdArray(a.to))).toEqual([[REMOTE_ACTOR_ID]]);

		// 拒否した Follow は、未承認の Follow の補正でも承認しない。
		const reconciled = await reconcilePendingFollows({ actorId: botId });
		expect(reconciled.reconciledCount).toBe(0);
		expect(await getFollowers('weather')).toEqual([DEV_HAKATASHI]);
	});

	test('open bots accept everyone, and the policy can be changed later', async () => {
		await createBot({ username: 'public_feed', followPolicy: { mode: 'open' } });
		const botId = localActorIri('public_feed');
		expect((await apex.store.getObject(botId))?.manuallyApprovesFollowers).toBe(false);

		await sendFollow('public_feed', REMOTE_ACTOR_ID, 'https://remote.example/follows/2');
		expect(await getFollowers('public_feed')).toEqual([REMOTE_ACTOR_ID]);

		const patched = await request(app)
			.patch('/activitypub/bots/public_feed')
			.set(adminHeader)
			.send({ followPolicy: { mode: 'allowlist', allowlist: [] } });
		expect(patched.status).toBe(200);
		expect((await apex.store.getObject(botId))?.manuallyApprovesFollowers).toBe(true);
		expect(apex.publishUpdate).toHaveBeenCalledTimes(1);
		// 承認済みのフォロワーは外さない。
		expect(await getFollowers('public_feed')).toEqual([REMOTE_ACTOR_ID]);

		expect(
			(
				await request(app)
					.patch('/activitypub/bots/missing')
					.set(adminHeader)
					.send({ followPolicy: { mode: 'open' } })
			).status,
		).toBe(404);
	});

	test('the primary actor keeps accepting every follow', async () => {
		await sendFollow('hakatashi', REMOTE_ACTOR_ID, 'https://remote.example/follows/3');
		expect(await getFollowers('hakatashi')).toEqual([REMOTE_ACTOR_ID]);
	});
});
