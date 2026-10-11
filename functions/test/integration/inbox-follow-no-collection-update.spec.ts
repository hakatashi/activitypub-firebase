import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { localFollowersId, localFollowingId } from '../../src/localActor.js';
import { Streams } from '../../src/schema.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;

const ALICE_ID = 'https://remote.example/u/alice';
const BOB_ID = 'https://remote.example/u/bob';
const CHARLIE_ID = 'https://remote.example/u/charlie';
const DAVID_ID = 'https://remote.example/u/david';

const ALICE_FOLLOW_ID = 'https://remote.example/activities/follow-alice';
const BOB_FOLLOW_ID = 'https://remote.example/activities/follow-bob';
const CHARLIE_FOLLOW_ID = 'https://remote.example/activities/follow-charlie';

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

describe('collection update delivery suppression (ADR-0112 / Issue #259)', () => {
	let originalEnv: string;

	let deliveryEnqueueSpy: ReturnType<typeof vi.spyOn>;

	const postToInbox = (activity: unknown) =>
		request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(activity));

	beforeEach(async () => {
		deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		await createLocalActor('hakatashi', {
			uid: 'firebase-uid',
			id: '1',
			userInfo: { created_at: '2023-01-01T00:00:00.000Z' },
		});

		// 既存のリモートユーザーたちを保存
		for (const [id, username] of [
			[ALICE_ID, 'alice'],
			[BOB_ID, 'bob'],
			[CHARLIE_ID, 'charlie'],
			[DAVID_ID, 'david'],
		] as const) {
			await apex.store.saveObject({
				id,
				type: 'Person',
				preferredUsername: username,
				inbox: `${id}/inbox`,
				outbox: `${id}/outbox`,
			});
		}

		originalEnv = app.get('env') as string;
		app.set('env', 'development');

		// 既にフォロワーが複数人 (alice, bob) いる状態を正規の Follow 受信で作成
		for (const [actorId, followId] of [
			[ALICE_ID, ALICE_FOLLOW_ID],
			[BOB_ID, BOB_FOLLOW_ID],
		] as const) {
			const follow = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: followId,
				type: 'Follow',
				actor: actorId,
				object: RECIPIENT_ID,
			};
			const res = await postToInbox(follow);
			expect(res.status).toBe(200);
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		app.set('env', originalEnv);
		await resetFirestore();
	});

	test('incoming Follow enqueues only Accept and does NOT enqueue collection Update even when multiple followers exist', async () => {
		deliveryEnqueueSpy.mockClear();

		const followFromCharlie = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: CHARLIE_FOLLOW_ID,
			type: 'Follow',
			actor: CHARLIE_ID,
			object: RECIPIENT_ID,
		};

		const res = await postToInbox(followFromCharlie);
		expect(res.status).toBe(200);

		// 配送タスクは Accept の 1 件のみ enqueue される (Update は積まれない)
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(1);

		const [actorId, body, inbox] = deliveryEnqueueSpy.mock.calls[0] ?? [];
		expect(actorId).toBe(RECIPIENT_ID);
		expect(inbox).toEqual([`${CHARLIE_ID}/inbox`]);

		const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
		expect(parsedBody.type).toBe('Accept');
		expect(parsedBody.object?.id ?? parsedBody.object).toBe(CHARLIE_FOLLOW_ID);

		// Update アクティビティが配送されていないことの確認
		const updateCalls = deliveryEnqueueSpy.mock.calls.filter((call: unknown[]) => {
			const callBody = call[1];
			const parsed = typeof callBody === 'string' ? JSON.parse(callBody) : callBody;
			return (parsed as { type?: string })?.type === 'Update';
		});
		expect(updateCalls).toHaveLength(0);
	});

	test('incoming Undo(Follow) removes the follow without enqueuing any Update deliveries', async () => {
		deliveryEnqueueSpy.mockClear();

		// Alice の Undo(Follow) を受信
		const undoFromAlice = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/undo-alice-1',
			type: 'Undo',
			actor: ALICE_ID,
			object: ALICE_FOLLOW_ID,
		};

		const res = await postToInbox(undoFromAlice);
		expect(res.status).toBe(200);

		// Update などの配送が一切積まれないこと
		expect(deliveryEnqueueSpy).not.toHaveBeenCalled();

		// Alice の Follow が削除または followers から除外されていること
		const followDoc = await Streams.doc(escapeFirestoreKey(ALICE_FOLLOW_ID)).get();
		const collections = (followDoc.data()?._meta?.collection as string[]) ?? [];
		expect(collections).not.toContain(localFollowersId);
	});

	test('incoming Reject removes our follow without enqueuing any Update deliveries', async () => {
		const localActor = await apex.store.getObject(RECIPIENT_ID, true);
		expect(localActor).toBeDefined();

		// ローカルユーザーが David に送った Follow を outbox に追加して保存
		const followActivity = await apex.buildActivity('Follow', RECIPIENT_ID, DAVID_ID, {
			object: DAVID_ID,
		});
		await apex.addToOutbox(localActor!, followActivity);
		// following コレクションにも追加されている状態にする (Accept 済みだった Follow を後から Reject されるケース)
		await apex.store.updateActivityMeta(followActivity, 'collection', localFollowingId, false);

		deliveryEnqueueSpy.mockClear();

		// David からの Reject を受信
		const rejectFromDavid = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/reject-david-1',
			type: 'Reject',
			actor: DAVID_ID,
			object: followActivity.id,
		};

		const res = await postToInbox(rejectFromDavid);
		expect(res.status).toBe(200);

		// Update などの配送が一切積まれないこと
		expect(deliveryEnqueueSpy).not.toHaveBeenCalled();

		// following コレクションから Follow が外れていること
		const followDoc = await Streams.doc(escapeFirestoreKey(followActivity.id)).get();
		const collections = (followDoc.data()?._meta?.collection as string[]) ?? [];
		expect(collections).not.toContain(localFollowingId);
	});
});
