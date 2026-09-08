import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub, apex, app } from '../../src/activitypub.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { Streams } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const DEV_DOMAIN = 'activitypub-dev.hakatashi.com';
const RECIPIENT_ID = `https://${DEV_DOMAIN}/activitypub/u/hakatashi`;
const NOTE_ID = `https://${DEV_DOMAIN}/activitypub/o/note-1`;
const REMOTE_ACTOR_ID = 'https://remote.example/u/alice';

// inbox-dedup.spec.ts と同じ理由(Cloud Functions ランタイムの req.rawBody 前提の再現)。
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

// Issue #55 の dev 実地検証で、mastodon-test.hakatashi.com からの Like/Announce
// (object が投稿=Note 自身の IRI)が常に 400 "Activity type object requried" で拒否され、
// 一切保存されないことを発見した。apex は Like/Announce の object を「actor を持つ別の
// アクティビティ」としてしか受理しないため (→ ADR-0038)。
describe('/inbox accepts Like/Announce targeting a plain object (Issue #55, ADR-0038)', () => {
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
		await apex.store.saveObject({
			id: NOTE_ID,
			type: 'Note',
			attributedTo: RECIPIENT_ID,
			content: 'hello world',
		});

		// apex.resolveActivity は Note のような通常オブジェクトに対しては
		// 「streams に無い→ HTTP で再取得→ validateActivity に失敗して破棄」という経路をたどる
		// (実際のネットワークアクセスを伴う)。テストでは実際の HTTP アクセスを避けるため、
		// 「解決できなかった」状態を直接再現する。
		vi.spyOn(apex, 'resolveActivity').mockResolvedValue(undefined);

		// security.verifySignature は development env でのみ Signature ヘッダなしを許す
		// (→ inbox-dedup.spec.ts と同じバイパス)。
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

	test('a Like on a Note is accepted and saved to streams', async () => {
		const deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const likeActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/like-1',
			type: 'Like',
			actor: REMOTE_ACTOR_ID,
			object: NOTE_ID,
		};

		const response = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(likeActivity));

		expect(response.status).toBe(200);

		const saved = await Streams.doc(escapeFirestoreKey(likeActivity.id)).get();
		expect(saved.exists).toBe(true);
		expect(saved.data()?.type).toBe('Like');

		deliveryEnqueueSpy.mockRestore();
	});

	test('an Announce on a Note is accepted and saved to streams', async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);

		const announceActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/announce-1',
			type: 'Announce',
			actor: REMOTE_ACTOR_ID,
			to: 'as:Public',
			object: NOTE_ID,
		};

		const response = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify(announceActivity));

		expect(response.status).toBe(200);

		const saved = await Streams.doc(escapeFirestoreKey(announceActivity.id)).get();
		expect(saved.exists).toBe(true);
		expect(saved.data()?.type).toBe('Announce');
	});
});
