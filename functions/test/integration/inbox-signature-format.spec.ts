import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { activitypub } from '../../src/activitypub.js';

const RECIPIENT_ID = 'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi';
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

// Issue #55 の dev 実地検証で、mastodon-test.hakatashi.com からの Like/Announce の配送が
// RFC 9421 形式の Signature ヘッダーを伴うと 500 になり、Sidekiq が無限に再送し続けることを
// 発見した (→ ADR-0036)。apex 本体の verifySignature に到達する前に 401 で弾かれることを固定する。
describe('/inbox rejects unsupported Signature header formats before apex (Issue #55, ADR-0036)', () => {
	test('responds 403, not 500, for an RFC 9421 style Signature header', async () => {
		const likeActivity = {
			'@context': 'https://www.w3.org/ns/activitystreams',
			id: 'https://remote.example/activities/like-1',
			type: 'Like',
			actor: REMOTE_ACTOR_ID,
			object: `${RECIPIENT_ID}/o/some-note`,
		};

		const response = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.set('Signature', 'sig1=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig==:')
			.send(JSON.stringify(likeActivity));

		expect(response.status).toBe(403);
	});
});
