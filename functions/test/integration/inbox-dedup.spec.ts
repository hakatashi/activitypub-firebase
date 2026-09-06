import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, apex, app } from '../../src/activitypub.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';

// Cloud Functions ランタイムは req.rawBody を用意し、activitypub.ts 先頭のミドルウェアが
// それを前提に JSON.parse(req.body) している(本番では Content-Type が application/activity+json
// でも body がテキストとして渡ってくる)。supertest で app を直接叩くとその前提が崩れ
// (req.body は素通しの Buffer のまま)、Express 標準の express.json() も
// application/activity+json にはマッチしないため req.body が空オブジェクトになってしまう。
// ここで Cloud Functions と同じ「req.body に生の文字列を積む」前処理を再現する。
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

describe('/inbox redundant delivery (Issue #50)', () => {
	let originalEnv: string;

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}

		const actor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(actor);
		await apex.store.saveObject({
			id: REMOTE_ACTOR_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE_ACTOR_ID}/inbox`,
			outbox: `${REMOTE_ACTOR_ID}/outbox`,
		});

		// security.verifySignature は Signature ヘッダがない場合 development env でのみ
		// 通過を許す(それ以外は 401)。HTTP 署名の実装自体はこの Issue のスコープ外なので、
		// ここでは development バイパスを使って重複排除ロジックだけを検証する。
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

	test('delivers Accept only once when the same Follow is POSTed to the inbox twice', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const followActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		};

		const postFollow = () =>
			request(wrapWithRawBody(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', 'application/activity+json')
				.send(JSON.stringify(followActivity));

		const first = await postFollow();
		expect(first.status).toBe(200);

		const second = await postFollow();
		expect(second.status).toBe(200);

		// Follow 自動承認1回につき、Accept の配送と followers コレクション更新の配送で
		// deliveryEnqueue が2回呼ばれる。重複配送で side effect が再実行されていれば、
		// 2回目の POST でさらに deliveryEnqueue が呼ばれ、合計が2回を超える。
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(2);
	});

	test('still runs side effects for a genuinely new delivery (different activity)', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const makeFollow = (id: string) => ({
			'@context': 'https://www.w3.org/ns/activitystreams',
			id,
			type: 'Follow',
			actor: REMOTE_ACTOR_ID,
			object: RECIPIENT_ID,
		});

		const postFollow = (activity: unknown) =>
			request(wrapWithRawBody(activitypub))
				.post('/activitypub/u/hakatashi/inbox')
				.set('Content-Type', 'application/activity+json')
				.send(JSON.stringify(activity));

		const first = await postFollow(makeFollow('https://remote.example/activities/follow-a'));
		expect(first.status).toBe(200);

		const second = await postFollow(makeFollow('https://remote.example/activities/follow-b'));
		expect(second.status).toBe(200);

		// 別の Follow activity なので、それぞれ独立して自動承認の side effect が走る
		// (Follow ごとに Accept の配送 + followers コレクション更新の配送で2回)。
		expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(4);
	});
});
