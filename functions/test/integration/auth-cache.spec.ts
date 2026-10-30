import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { AccessTokens, Objects, UserInfos } from '../../src/schema.js';
import {
	addAccessToken,
	createLocalActor,
	mastodon as mastodonReq,
	resetFirestore,
} from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const TOKEN = 'me-token';

// 認証の結果と閲覧者の actor のインスタンス内キャッシュ (→ ADR-0169)。
describe('auth and viewer cache (Issue #358, ADR-0169)', () => {
	let me: LocalActor;

	beforeEach(async () => {
		me = await createLocalActor('hakatashi');
		await addAccessToken(TOKEN, 'read write');
	});

	afterEach(async () => {
		await resetFirestore();
	});

	test('keeps accepting a token whose document was deleted until the cache expires', async () => {
		expect((await mastodonReq.get('/api/v1/preferences', TOKEN)).status).toBe(200);

		const docs = await AccessTokens.where('accessToken', '==', TOKEN).get();
		await Promise.all(docs.docs.map((doc) => doc.ref.delete()));

		expect((await mastodonReq.get('/api/v1/preferences', TOKEN)).status).toBe(200);
		expect((await mastodonReq.get('/api/v1/preferences', 'unknown-token')).status).toBe(401);
	});

	test('serves the cached viewer until a route that touches the timeline view invalidates it', async () => {
		const first = await mastodonReq.get('/api/v1/accounts/verify_credentials', TOKEN);
		expect(first.status).toBe(200);
		expect(first.body.display_name).toBe('hakatashi');

		await Objects.doc(escapeFirestoreKey(me.id)).update({ name: 'renamed' });
		const cached = await mastodonReq.get('/api/v1/accounts/verify_credentials', TOKEN);
		expect(cached.body.display_name).toBe('hakatashi');

		const updated = await mastodonReq
			.patch('/api/v1/accounts/update_credentials', TOKEN)
			.send({ note: 'hello' });
		expect(updated.status).toBe(200);
		// update_credentials は保存する actor をキャッシュではなく Firestore から読む (→ ADR-0169 決定5)。
		expect(updated.body.display_name).toBe('renamed');

		const fresh = await mastodonReq.get('/api/v1/accounts/verify_credentials', TOKEN);
		expect(fresh.body.display_name).toBe('renamed');
	});

	test('verify_credentials reads the latest counters instead of the cached UserInfo', async () => {
		expect((await mastodonReq.get('/api/v1/accounts/verify_credentials', TOKEN)).status).toBe(200);

		await UserInfos.doc(escapeFirestoreKey(me.id)).update({ statuses_count: 42 });

		const res = await mastodonReq.get('/api/v1/accounts/verify_credentials', TOKEN);
		expect(res.body.statuses_count).toBe(42);
	});
});
