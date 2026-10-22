import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { instanceConfig } from '../../src/firebase.js';
import { localActorIri, localFollowersIri } from '../../src/localActor.js';
import { AccessTokens } from '../../src/schema.js';
import { createBot } from '../../src/social/bots.js';
import { toIdArray } from '../../src/utils.js';
import { addAccessToken, createLocalActor, mastodon, resetFirestore } from '../helpers/index.js';

const adminHeader = { 'x-hakatashi-token': 'test-token' };

describe('bot operator token (ADR-0151)', () => {
	let operatorToken: string;

	beforeEach(async () => {
		process.env.HAKATASHI_TOKEN = 'test-token';
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
		await addAccessToken('me-token', 'read write', 'uid-hakatashi');
		await createBot({ username: 'weather' });
		await createBot({ username: 'feed', followPolicy: { mode: 'open', allowlist: [] } });

		const res = await request(app).post('/activitypub/bots/operator-token').set(adminHeader);
		expect(res.status).toBe(201);
		expect(res.headers['cache-control']).toBe('no-store');
		operatorToken = res.body.accessToken as string;
	});

	afterEach(async () => {
		delete process.env.HAKATASHI_TOKEN;
		vi.restoreAllMocks();
		await resetFirestore();
	});

	const postAs = (
		username: string | undefined,
		body: Record<string, unknown>,
		token = operatorToken,
	) => {
		const req = mastodon.post('/api/v1/statuses', token);
		if (username !== undefined) {
			req.set('X-Bot-Account', username);
		}
		return req.send(body);
	};

	test('posts as the bot named by X-Bot-Account with one token', async () => {
		const weather = await postAs('weather', { status: '晴れ' });
		expect(weather.status).toBe(200);
		expect(weather.body.account.username).toBe('weather');
		expect(weather.body.account.bot).toBe(true);
		// allowlist のボットの既定の公開範囲は private (→ ADR-0150 決定7)。
		expect(weather.body.visibility).toBe('private');
		expect(weather.body.url).toMatch(/\/@weather\/\d+$/u);

		const note = await apex.store.getObject(weather.body.uri as string);
		expect(toIdArray(note?.attributedTo)).toEqual([localActorIri('weather')]);
		expect(toIdArray(note?.to)).toEqual([localFollowersIri('weather')]);

		const feed = await postAs('Feed', { status: 'new entry', visibility: 'public' });
		expect(feed.status).toBe(200);
		expect(feed.body.account.username).toBe('feed');
		expect(feed.body.visibility).toBe('public');

		const credentials = await mastodon
			.get('/api/v1/accounts/verify_credentials', operatorToken)
			.set('X-Bot-Account', 'feed');
		expect(credentials.status).toBe(200);
		expect(credentials.body.username).toBe('feed');
	});

	test('rejects a missing, unknown or non-bot X-Bot-Account', async () => {
		expect((await postAs(undefined, { status: 'x' })).status).toBe(401);
		expect((await postAs('nobody', { status: 'x' })).status).toBe(401);
		expect((await postAs('../hakatashi', { status: 'x' })).status).toBe(401);
		expect((await postAs('hakatashi', { status: 'x' })).status).toBe(403);
	});

	test('ignores X-Bot-Account on ordinary tokens', async () => {
		const res = await postAs('weather', { status: 'mine' }, 'me-token');
		expect(res.status).toBe(200);
		expect(res.body.account.username).toBe('hakatashi');
	});

	test('does not work when bots are disabled on the instance', async () => {
		instanceConfig.bots.enabled = false;
		try {
			expect((await postAs('weather', { status: 'x' })).status).toBe(401);
		} finally {
			instanceConfig.bots.enabled = true;
		}
	});

	test('revokes every operator token', async () => {
		const res = await request(app).delete('/activitypub/bots/operator-token').set(adminHeader);
		expect(res.body).toEqual({ revoked: 1 });
		expect((await postAs('weather', { status: 'x' })).status).toBe(401);
		expect((await AccessTokens.get()).size).toBe(1);
	});

	test('requires the admin token to issue one', async () => {
		expect((await request(app).post('/activitypub/bots/operator-token')).status).toBe(403);
	});
});
