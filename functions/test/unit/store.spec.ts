import {describe, expect, test, afterEach, beforeEach} from 'vitest';
import Store from '../../src/store.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

describe('Store', () => {
	const store = new Store();

	beforeEach(() => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
	});

	// Teardown firestore database after each test
	afterEach(async () => {
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{
				method: 'DELETE',
			},
		);
	});

	describe('saveObject / getObject', () => {
		test('round-trips an object', async () => {
			const object = {id: 'https://example.com/objects/1', type: 'Note', content: 'hello'};
			await store.saveObject(object);
			expect(await store.getObject(object.id)).toEqual(object);
		});

		test('strips _meta by default but keeps it when includeMeta is true', async () => {
			const object = {id: 'https://example.com/objects/2', type: 'Note', _meta: {collection: ['inbox']}};
			await store.saveObject(object);
			expect(await store.getObject(object.id)).not.toHaveProperty('_meta');
			expect(await store.getObject(object.id, true)).toHaveProperty('_meta', {collection: ['inbox']});
		});

		test('returns undefined for a non-existent object', async () => {
			expect(await store.getObject('https://example.com/objects/missing')).toBeUndefined();
		});

		test('escapes special characters in the id when used as a document key', async () => {
			// "/" や "." を含む URL がそのまま Firestore のドキュメント ID になっても壊れないことを確認する。
			const object = {id: 'https://example.com/users/foo.bar/statuses/1', type: 'Note'};
			await store.saveObject(object);
			expect(await store.getObject(object.id)).toEqual(object);
		});
	});

	describe('getObjects', () => {
		test('returns an empty array for an empty id list', async () => {
			expect(await store.getObjects([])).toEqual([]);
		});

		test('fetches multiple objects by id', async () => {
			const objects = [
				{id: 'https://example.com/objects/a', type: 'Note'},
				{id: 'https://example.com/objects/b', type: 'Note'},
			];
			await Promise.all(objects.map((object) => store.saveObject(object)));

			const result = await store.getObjects(objects.map((object) => object.id));
			expect(result).toEqual(expect.arrayContaining(objects));
			expect(result).toHaveLength(2);
		});
	});

	describe('saveActivity / getActivity', () => {
		// apex は _meta.collection を常に配列で保持する(activitypub-express の
		// addMeta が [value] で初期化するため)。Store はこれを Firestore 上では
		// スカラー文字列として保存し(getStream の等価フィルタで引くため)、
		// 読み出し時に配列へ戻す。
		test('round-trips an activity, storing _meta.collection as a scalar and restoring it as an array', async () => {
			const activity = {
				id: 'https://example.com/activities/1',
				type: 'Create',
				_meta: {collection: ['https://example.com/inbox']},
			};
			expect(await store.saveActivity(activity)).toBe(true);

			const fetched = await store.getActivity(activity.id, true);
			expect(fetched?._meta.collection).toEqual(['https://example.com/inbox']);
		});

		test('does not overwrite an existing activity with the same id', async () => {
			const activity = {id: 'https://example.com/activities/2', type: 'Create'};
			expect(await store.saveActivity(activity)).toBe(true);
			expect(await store.saveActivity({...activity, type: 'Update'})).toBeUndefined();

			const fetched = await store.getActivity(activity.id);
			expect(fetched?.type).toBe('Create');
		});
	});

	describe('getStream', () => {
		test('filters by _meta.collection and denormalizes it back to an array', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/in-inbox',
				type: 'Create',
				_meta: {collection: ['https://example.com/inbox']},
			});
			await store.saveActivity({
				id: 'https://example.com/activities/in-outbox',
				type: 'Create',
				_meta: {collection: ['https://example.com/outbox']},
			});

			const stream = await store.getStream('https://example.com/inbox', null, null);
			expect(stream).toHaveLength(1);
			expect(stream[0].id).toBe('https://example.com/activities/in-inbox');
			expect(stream[0]._meta.collection).toEqual(['https://example.com/inbox']);
		});

		test('respects the limit argument', async () => {
			await Promise.all(['1', '2', '3'].map((suffix) => store.saveActivity({
				id: `https://example.com/activities/limit-${suffix}`,
				type: 'Create',
				_meta: {collection: ['https://example.com/inbox']},
			})));

			const stream = await store.getStream('https://example.com/inbox', 2, null);
			expect(stream).toHaveLength(2);
		});

		test('passing a non-empty blockList currently makes the query fail', async () => {
			// Firestore は not-in フィルタを使う場合、最初の orderBy をそのフィールドに
			// することを要求する。getStream は orderBy を常に documentId() のみにしているため、
			// blockList を渡すと "order by clause cannot contain more fields after the key" で
			// クエリ自体が失敗する。つまり blockList 引数は現状まったく機能しない。
			// docs/known-issues.md の「blockList を渡すと getStream が例外を投げる」参照。
			await store.saveActivity({
				id: 'https://example.com/activities/from-someone',
				type: 'Create',
				actor: 'https://example.com/users/someone',
				_meta: {collection: ['https://example.com/inbox']},
			});

			await expect(store.getStream(
				'https://example.com/inbox',
				null,
				null,
				['https://example.com/users/blocked'],
			)).rejects.toThrow('order by clause cannot contain more fields after the key');
		});
	});

	describe('removeActivity', () => {
		test('removes an activity attributed to the given actor', async () => {
			const activity = {
				id: 'https://example.com/activities/removable',
				type: 'Create',
				actor: ['https://example.com/users/actor'],
			};
			await store.saveActivity(activity);
			expect(await store.getActivity(activity.id)).toBeDefined();

			await store.removeActivity(activity, 'https://example.com/users/actor');
			expect(await store.getActivity(activity.id)).toBeUndefined();
		});
	});

	describe('recordDeliveryResult / getDelivery / getFailedDeliveries', () => {
		const activityId = 'https://example.com/activities/1';
		const actorId = 'https://example.com/users/hakatashi';
		const address = 'https://remote.example/u/alice/inbox';
		const body = '{"id":"https://example.com/activities/1","type":"Create"}';

		test('round-trips a successful delivery', async () => {
			await store.recordDeliveryResult({
				activityId, actorId, address, body, attempts: 1, status: 'success', statusCode: 202,
			});

			const delivery = await store.getDelivery(activityId, address);
			expect(delivery).toMatchObject({
				activityId, actorId, inbox: address, body, attempts: 1, status: 'success', statusCode: 202, error: null,
			});
		});

		test('overwrites the previous record for the same activity/address pair', async () => {
			await store.recordDeliveryResult({
				activityId, actorId, address, body, attempts: 1, status: 'retrying', statusCode: 503, error: 'boom',
			});
			await store.recordDeliveryResult({
				activityId, actorId, address, body, attempts: 2, status: 'success', statusCode: 202,
			});

			const delivery = await store.getDelivery(activityId, address);
			expect(delivery).toMatchObject({attempts: 2, status: 'success', error: null});
		});

		test('getDelivery returns undefined for an unknown pair', async () => {
			expect(await store.getDelivery(activityId, address)).toBeUndefined();
		});

		test('getFailedDeliveries lists only permanent_failure and retrying deliveries', async () => {
			await store.recordDeliveryResult({
				activityId, actorId, address, body, attempts: 1, status: 'success', statusCode: 202,
			});
			await store.recordDeliveryResult({
				activityId: 'https://example.com/activities/2',
				actorId,
				body,
				address: 'https://remote.example/u/bob/inbox',
				attempts: 1,
				status: 'permanent_failure',
				statusCode: 410,
			});
			await store.recordDeliveryResult({
				activityId: 'https://example.com/activities/3',
				actorId,
				body,
				address: 'https://remote.example/u/carol/inbox',
				attempts: 1,
				status: 'retrying',
				statusCode: 503,
				error: 'boom',
			});

			const failed = await store.getFailedDeliveries();
			expect(failed).toHaveLength(2);
			expect(failed.map((delivery) => delivery.status).sort()).toEqual(['permanent_failure', 'retrying']);
		});
	});
});
