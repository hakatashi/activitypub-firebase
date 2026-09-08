import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, apex, app } from '../../src/activitypub.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const LOCAL_ACTOR_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const LOCAL_FOLLOWERS_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi/followers`;
const FOLLOWER_ALICE_ID = 'https://remote-a.example/u/alice';
const FOLLOWER_ALICE_INBOX = 'https://remote-a.example/u/alice/inbox';
const REMOTE_BOB_ID = 'https://remote-b.example/u/bob';
const REMOTE_BOB_INBOX = 'https://remote-b.example/u/bob/inbox';

const wrapWithRawBody = (target: unknown) => {
	const wrapper = express();
	wrapper.use(
		express.raw({ type: () => true, limit: '10mb' }),
		(req, res, next) => {
			req.body = (req.body as Buffer).toString('utf-8');
			next();
		},
		target as unknown as express.RequestHandler,
	);
	return wrapper;
};

describe('/inbox forwarding (W3C ActivityPub 7.1.2, Issue #54)', () => {
	let originalEnv: string;

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}

		// 1. ローカルアクターの作成
		const localActor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(localActor);

		// 2. フォロワー Alice のセットアップ (アクター保存 + Follow アクティビティを followers コレクションに登録)
		await apex.store.saveObject({
			id: FOLLOWER_ALICE_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: [FOLLOWER_ALICE_INBOX],
			outbox: [`${FOLLOWER_ALICE_ID}/outbox`],
		});
		await apex.store.saveActivity({
			id: 'https://remote-a.example/activities/follow-1',
			type: 'Follow',
			actor: [FOLLOWER_ALICE_ID],
			object: [LOCAL_ACTOR_ID],
			_meta: {
				collection: [LOCAL_FOLLOWERS_ID],
			},
		});

		// 3. 外部ユーザー Bob のセットアップ
		await apex.store.saveObject({
			id: REMOTE_BOB_ID,
			type: 'Person',
			preferredUsername: 'bob',
			inbox: [REMOTE_BOB_INBOX],
			outbox: [`${REMOTE_BOB_ID}/outbox`],
		});

		// 4. ローカルアクターの親投稿 Note
		const parentNoteId = `https://${DEV_DOMAIN}/activitypub/u/hakatashi/o/parent-note-1`;
		await apex.store.saveObject({
			id: parentNoteId,
			type: 'Note',
			attributedTo: LOCAL_ACTOR_ID,
			to: ['as:Public'],
			cc: [LOCAL_FOLLOWERS_ID],
			content: 'This is my original post!',
		});

		originalEnv = app.get('env') as string;
		app.set('env', 'development');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		app.set('env', originalEnv);
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	test.each([
		['as:Public', 'as:Public'],
		['full URI', 'https://www.w3.org/ns/activitystreams#Public'],
		['bare Public', 'Public'],
	])(
		'forwards remote reply to followers when all 3 conditions are met (%s)',
		async (_label, publicTarget) => {
			const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

			const replyActivityId = `https://remote-b.example/activities/reply-${encodeURIComponent(publicTarget)}`;
			const replyNoteId = `https://remote-b.example/objects/reply-note-${encodeURIComponent(publicTarget)}`;
			const parentNoteId = `https://${DEV_DOMAIN}/activitypub/u/hakatashi/o/parent-note-1`;

			const replyCreateActivity = {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: replyActivityId,
				type: 'Create',
				actor: REMOTE_BOB_ID,
				to: [LOCAL_ACTOR_ID, publicTarget],
				cc: [LOCAL_FOLLOWERS_ID],
				object: {
					id: replyNoteId,
					type: 'Note',
					attributedTo: REMOTE_BOB_ID,
					inReplyTo: parentNoteId,
					to: [LOCAL_ACTOR_ID, publicTarget],
					cc: [LOCAL_FOLLOWERS_ID],
					content: 'Nice reply from Bob!',
				},
			};

			const res = await request(wrapWithRawBody(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', 'application/activity+json')
				.send(JSON.stringify(replyCreateActivity));

			expect(res.status).toBe(200);

			// フォロワー Alice への転送配送がエンキューされていることを確認
			expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(1);
			expect(deliveryEnqueueSpy).toHaveBeenCalledWith(
				LOCAL_ACTOR_ID,
				expect.any(String),
				[FOLLOWER_ALICE_INBOX],
				expect.any(String),
			);

			// エンキューされた body を検証 (元の Create アクティビティが含まれる)
			const deliveredBody = JSON.parse(deliveryEnqueueSpy.mock.calls[0][1] as string);
			expect(deliveredBody.id).toBe(replyActivityId);
			expect(deliveredBody.type).toBe('Create');
		},
	);

	test('does not forward redundant deliveries (condition 1)', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const replyActivityId = 'https://remote-b.example/activities/reply-dedup-test';
		const replyCreateActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: replyActivityId,
			type: 'Create',
			actor: REMOTE_BOB_ID,
			to: [LOCAL_ACTOR_ID, 'as:Public'],
			cc: [LOCAL_FOLLOWERS_ID],
			object: {
				id: 'https://remote-b.example/objects/reply-dedup-note',
				type: 'Note',
				attributedTo: REMOTE_BOB_ID,
				inReplyTo: `https://${DEV_DOMAIN}/activitypub/u/hakatashi/o/parent-note-1`,
				to: [LOCAL_ACTOR_ID, 'as:Public'],
				cc: [LOCAL_FOLLOWERS_ID],
				content: 'Duplicated reply',
			},
		};

		const postReply = () =>
			request(wrapWithRawBody(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', 'application/activity+json')
				.send(JSON.stringify(replyCreateActivity));

		const first = await postReply();
		expect(first.status).toBe(200);
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(1);

		// 2回目の同一アクティビティ POST (重複配送)
		const second = await postReply();
		expect(second.status).toBe(200);
		// 重複配送では転送されないため、呼び出し回数は 1 回のまま
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(1);
	});

	test('does not forward when inReplyTo is not a local object (condition 2)', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const replyCreateActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote-b.example/activities/reply-external-parent',
			type: 'Create',
			actor: REMOTE_BOB_ID,
			to: [LOCAL_ACTOR_ID, 'as:Public'],
			cc: [LOCAL_FOLLOWERS_ID],
			object: {
				id: 'https://remote-b.example/objects/reply-external-note',
				type: 'Note',
				attributedTo: REMOTE_BOB_ID,
				inReplyTo: 'https://other-remote.example/o/some-external-note',
				to: [LOCAL_ACTOR_ID, 'as:Public'],
				cc: [LOCAL_FOLLOWERS_ID],
				content: 'Reply to some external post',
			},
		};

		const res = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(replyCreateActivity));

		expect(res.status).toBe(200);
		// ローカルオブジェクトへの返信ではないため転送されない
		expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
	});

	test('does not forward when followers collection is not in addressing (condition 3)', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const replyCreateActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote-b.example/activities/reply-direct-only',
			type: 'Create',
			actor: REMOTE_BOB_ID,
			to: [LOCAL_ACTOR_ID],
			// cc にフォロワーコレクションを含めない (ダイレクトメッセージ等)
			object: {
				id: 'https://remote-b.example/objects/reply-direct-note',
				type: 'Note',
				attributedTo: REMOTE_BOB_ID,
				inReplyTo: `https://${DEV_DOMAIN}/activitypub/u/hakatashi/o/parent-note-1`,
				to: [LOCAL_ACTOR_ID],
				content: 'Direct reply to you only',
			},
		};

		const res = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(replyCreateActivity));

		expect(res.status).toBe(200);
		// フォロワーコレクション宛てではないため転送されない
		expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
	});
});
