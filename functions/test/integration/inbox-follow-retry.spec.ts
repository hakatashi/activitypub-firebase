import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { localFollowersId, localInboxId } from '../../src/localActor.js';
import { FollowRelations, Streams, UserInfos } from '../../src/schema.js';
import { reconcilePendingFollows } from '../../src/social/follows.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';
const FOLLOW_ID = 'https://remote.example/activities/follow-retry-1';

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

describe('inbox Follow error recovery and retry (ADR-0111 / Issue #258)', () => {
	let originalEnv: string;

	beforeEach(async () => {
		await createLocalActor('hakatashi', {
			uid: 'firebase-uid',
			id: '1',
			userInfo: { created_at: '2023-01-01T00:00:00.000Z' },
		});
		await apex.store.saveObject({
			id: REMOTE_ACTOR_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE_ACTOR_ID}/inbox`,
			outbox: `${REMOTE_ACTOR_ID}/outbox`,
		});

		originalEnv = app.get('env') as string;
		app.set('env', 'development');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		app.set('env', originalEnv);
		await resetFirestore();
	});

	const followActivity = {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: FOLLOW_ID,
		type: 'Follow',
		actor: REMOTE_ACTOR_ID,
		object: RECIPIENT_ID,
	};

	const postFollow = (activity: unknown = followActivity) =>
		request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(activity));

	test('returns 500 when follow acceptance throws, and retrying the same follow succeeds without double-counting', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		// 1回目: acceptFollow でエラー (トランザクション競合等の失敗をシミュレート)
		const originalAcceptFollow = apex.acceptFollow.bind(apex);
		const acceptFollowSpy = vi
			.spyOn(apex, 'acceptFollow')
			.mockRejectedValueOnce(new Error('firestore transaction conflict'));

		const firstRes = await postFollow();
		expect(firstRes.status).toBe(500);

		// 1回目の失敗時点で Follow は Streams に保存されているが、followers には入っていない
		const followDocAfterFirst = await Streams.doc(escapeFirestoreKey(FOLLOW_ID)).get();
		expect(followDocAfterFirst.exists).toBe(true);
		const collectionsAfterFirst = (followDocAfterFirst.data()?._meta?.collection as string[]) ?? [];
		expect(collectionsAfterFirst).not.toContain(localFollowersId);

		// 射影とカウンタもまだ増えていない
		const userInfoAfterFirst = await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get();
		expect(userInfoAfterFirst.data()?.followers_count).toBe(0);

		// 2回目: 同じ Follow を再送 (相手サーバーのリトライ)
		acceptFollowSpy.mockImplementation(originalAcceptFollow);

		const secondRes = await postFollow();
		expect(secondRes.status).toBe(200);

		// 2回目で承認され、followers コレクションに追加されている
		const followDocAfterSecond = await Streams.doc(escapeFirestoreKey(FOLLOW_ID)).get();
		const collectionsAfterSecond =
			(followDocAfterSecond.data()?._meta?.collection as string[]) ?? [];
		expect(collectionsAfterSecond).toContain(localFollowersId);

		// 射影が作成され、カウンタが 1 になる
		const relationDoc = await FollowRelations(escapeFirestoreKey(RECIPIENT_ID), 'followers')
			.doc(escapeFirestoreKey(REMOTE_ACTOR_ID))
			.get();
		expect(relationDoc.exists).toBe(true);

		const userInfoAfterSecond = await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get();
		expect(userInfoAfterSecond.data()?.followers_count).toBe(1);

		// Accept と followers 更新の配送が enqueue されている (2回)
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(2);

		// 3回目: 承認済みの Follow が再送された場合は何もしない (素通り 200)
		const thirdRes = await postFollow();
		expect(thirdRes.status).toBe(200);

		// カウンタも配送回数も増えていない
		const userInfoAfterThird = await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get();
		expect(userInfoAfterThird.data()?.followers_count).toBe(1);
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(2);
	});

	test('returns 500 when addToOutbox throws in inbox processing', async () => {
		vi.spyOn(apex, 'addToOutbox').mockRejectedValueOnce(new Error('tasks enqueue failed'));

		const res = await postFollow();
		expect(res.status).toBe(500);
	});

	test('reconcilePendingFollows detects and reconciles unaccepted follows', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		// 未承認の Follow を inbox に保存する (followers コレクションには含めない)
		await Streams.doc(escapeFirestoreKey(FOLLOW_ID)).set({
			...followActivity,
			_meta: {
				collection: [localInboxId],
			},
		});

		// dryRun: true では検出されるが実行されない
		const dryRunResult = await reconcilePendingFollows({ dryRun: true });
		expect(dryRunResult.pendingFollows).toHaveLength(1);
		expect(dryRunResult.pendingFollows[0]?.id).toBe(FOLLOW_ID);
		expect(dryRunResult.pendingFollows[0]?.actor).toBe(REMOTE_ACTOR_ID);
		expect(dryRunResult.reconciledCount).toBe(0);

		const followDocBeforeReconcile = await Streams.doc(escapeFirestoreKey(FOLLOW_ID)).get();
		expect((followDocBeforeReconcile.data()?._meta?.collection as string[]) ?? []).not.toContain(
			localFollowersId,
		);

		// dryRun: false で承認を実行
		const reconcileResult = await reconcilePendingFollows({ dryRun: false });
		expect(reconcileResult.pendingFollows).toHaveLength(1);
		expect(reconcileResult.reconciledCount).toBe(1);

		// followers に追加され、カウンタが 1 になる
		const followDocAfterReconcile = await Streams.doc(escapeFirestoreKey(FOLLOW_ID)).get();
		expect((followDocAfterReconcile.data()?._meta?.collection as string[]) ?? []).toContain(
			localFollowersId,
		);

		const userInfo = await UserInfos.doc(escapeFirestoreKey(RECIPIENT_ID)).get();
		expect(userInfo.data()?.followers_count).toBe(1);
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(2);

		// 再度実行すると未承認 Follow は 0 件
		const secondReconcile = await reconcilePendingFollows({ dryRun: false });
		expect(secondReconcile.pendingFollows).toHaveLength(0);
		expect(secondReconcile.reconciledCount).toBe(0);
	});
});
