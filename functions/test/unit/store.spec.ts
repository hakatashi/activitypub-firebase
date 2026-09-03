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
});
