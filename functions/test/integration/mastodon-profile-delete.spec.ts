import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { defaultAvatarUrl, defaultHeaderUrl } from '../../src/mastodon/defaultImages.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import {
	getMediaStorageBucketName,
	resetMediaStorageDriver,
	setMediaStorageDriver,
} from '../../src/storage/media.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';

describe('DELETE /api/v1/profile/avatar and header (Issue #220)', () => {
	let me: LocalActor;
	let deletedPaths: string[];

	const addToken = (token: string, scope: string, uid = UID_ME) =>
		addAccessToken(token, scope, uid);

	beforeEach(async () => {
		await resetFirestore();
		deletedPaths = [];

		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);

		setMediaStorageDriver({
			upload() {
				throw new Error('Not implemented');
			},
			uploadPreview() {
				throw new Error('Not implemented');
			},
			delete(paths: string[]) {
				deletedPaths.push(...paths);
				return Promise.resolve();
			},
		});

		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetMediaStorageDriver();
		await resetFirestore();
	});

	describe('DELETE /api/v1/profile/avatar', () => {
		test('returns 401 when unauthorized', async () => {
			const res = await request(mastodon).delete('/api/v1/profile/avatar');
			expect(res.status).toBe(401);
		});

		test('returns 403 when scope is insufficient', async () => {
			await addToken('read-token', 'read');
			const res = await request(mastodon)
				.delete('/api/v1/profile/avatar')
				.set('Authorization', 'Bearer read-token');
			expect(res.status).toBe(403);
		});

		test('deletes avatar and delivers Update(Person)', async () => {
			await addToken('write-token', 'write:accounts');

			// 事前にアバターを設定
			const actor = (await apex.store.getObject(me.id))!;
			const bucketName = getMediaStorageBucketName();
			actor.icon = {
				type: 'Image',
				mediaType: 'image/png',
				url: `https://storage.googleapis.com/${bucketName}/accounts/avatars/old-avatar.png`,
			};
			await apex.store.saveObject(actor);

			const res = await request(mastodon)
				.delete('/api/v1/profile/avatar')
				.set('Authorization', 'Bearer write-token');

			expect(res.status).toBe(200);
			expect(res.body.avatar).toBe(defaultAvatarUrl);
			expect(res.body.avatar_static).toBe(defaultAvatarUrl);
			expect(deletedPaths).toContain('accounts/avatars/old-avatar.png');
			expect(apex.publishUpdate).toHaveBeenCalled();

			const updatedActor = await apex.store.getObject(me.id);
			expect(updatedActor?.icon).toBeUndefined();
		});

		test('returns 200 even if no avatar was set', async () => {
			await addToken('write-token', 'write:accounts');

			const actor = (await apex.store.getObject(me.id))!;
			delete actor.icon;
			await apex.store.saveObject(actor);

			const res = await request(mastodon)
				.delete('/api/v1/profile/avatar')
				.set('Authorization', 'Bearer write-token');

			expect(res.status).toBe(200);
			expect(res.body.avatar).toBe(defaultAvatarUrl);
			expect(deletedPaths).toHaveLength(0);
		});
	});

	describe('DELETE /api/v1/profile/header', () => {
		test('returns 401 when unauthorized', async () => {
			const res = await request(mastodon).delete('/api/v1/profile/header');
			expect(res.status).toBe(401);
		});

		test('returns 403 when scope is insufficient', async () => {
			await addToken('read-token', 'read');
			const res = await request(mastodon)
				.delete('/api/v1/profile/header')
				.set('Authorization', 'Bearer read-token');
			expect(res.status).toBe(403);
		});

		test('deletes header and delivers Update(Person)', async () => {
			await addToken('write-token', 'write:accounts');

			// 事前にヘッダーを設定
			const actor = (await apex.store.getObject(me.id))!;
			const bucketName = getMediaStorageBucketName();
			actor.image = {
				type: 'Image',
				mediaType: 'image/png',
				url: `https://storage.googleapis.com/${bucketName}/accounts/headers/old-header.png`,
			};
			await apex.store.saveObject(actor);

			const res = await request(mastodon)
				.delete('/api/v1/profile/header')
				.set('Authorization', 'Bearer write-token');

			expect(res.status).toBe(200);
			expect(res.body.header).toBe(defaultHeaderUrl);
			expect(res.body.header_static).toBe(defaultHeaderUrl);
			expect(deletedPaths).toContain('accounts/headers/old-header.png');
			expect(apex.publishUpdate).toHaveBeenCalled();

			const updatedActor = await apex.store.getObject(me.id);
			expect(updatedActor?.image).toBeUndefined();
		});

		test('returns 200 even if no header was set', async () => {
			await addToken('write-token', 'write:accounts');

			const res = await request(mastodon)
				.delete('/api/v1/profile/header')
				.set('Authorization', 'Bearer write-token');

			expect(res.status).toBe(200);
			expect(res.body.header).toBe(defaultHeaderUrl);
			expect(deletedPaths).toHaveLength(0);
		});
	});
});
