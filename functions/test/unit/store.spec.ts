import { describe, expect, test, afterEach, beforeEach } from 'vitest';
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
			const object = { id: 'https://example.com/objects/1', type: 'Note', content: 'hello' };
			await store.saveObject(object);
			expect(await store.getObject(object.id)).toEqual(object);
		});

		test('strips _meta by default but keeps it when includeMeta is true', async () => {
			const object = {
				id: 'https://example.com/objects/2',
				type: 'Note',
				_meta: { collection: ['inbox'] },
			};
			await store.saveObject(object);
			expect(await store.getObject(object.id)).not.toHaveProperty('_meta');
			expect(await store.getObject(object.id, true)).toHaveProperty('_meta', {
				collection: ['inbox'],
			});
		});

		test('returns undefined for a non-existent object', async () => {
			expect(await store.getObject('https://example.com/objects/missing')).toBeUndefined();
		});

		test('escapes special characters in the id when used as a document key', async () => {
			// "/" や "." を含む URL がそのまま Firestore のドキュメント ID になっても壊れないことを確認する。
			const object = { id: 'https://example.com/users/foo.bar/statuses/1', type: 'Note' };
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
				{ id: 'https://example.com/objects/a', type: 'Note' },
				{ id: 'https://example.com/objects/b', type: 'Note' },
			];
			await Promise.all(objects.map((object) => store.saveObject(object)));

			const result = await store.getObjects(objects.map((object) => object.id));
			expect(result).toEqual(expect.arrayContaining(objects));
			expect(result).toHaveLength(2);
		});

		test('fetches more than 30 objects by chunking the "in" query', async () => {
			// Firestore の `in` は最大30件までしか指定できないため、31件以上を渡した場合に
			// チャンク分割して結合されることを固定する。
			const objects = Array.from({ length: 31 }, (_, i) => ({
				id: `https://example.com/objects/chunk-${i}`,
				type: 'Note',
			}));
			await Promise.all(objects.map((object) => store.saveObject(object)));

			const result = await store.getObjects(objects.map((object) => object.id));
			expect(result).toEqual(expect.arrayContaining(objects));
			expect(result).toHaveLength(31);
		});
	});

	describe('saveActivity / getActivity', () => {
		// apex は _meta.collection を常に配列で保持する(activitypub-express の
		// addMeta が [value] で初期化するため)。Store もこれをそのまま配列で
		// 保存・返却する(→ ADR-0017)。
		test('round-trips an activity, keeping _meta.collection as an array', async () => {
			const activity = {
				id: 'https://example.com/activities/1',
				type: 'Create',
				_meta: { collection: ['https://example.com/inbox'] },
			};
			expect(await store.saveActivity(activity)).toBe(true);

			const fetched = await store.getActivity(activity.id, true);
			expect(fetched?._meta.collection).toEqual(['https://example.com/inbox']);
		});

		test('does not overwrite an existing activity with the same id', async () => {
			const activity = { id: 'https://example.com/activities/2', type: 'Create' };
			expect(await store.saveActivity(activity)).toBe(true);
			expect(await store.saveActivity({ ...activity, type: 'Update' })).toBeUndefined();

			const fetched = await store.getActivity(activity.id);
			expect(fetched?.type).toBe('Create');
		});
	});

	// findActivityByCollectionAndObjectId/ActorId は生の object/actor フィールドではなく
	// denormalizations.ts が書き込む _meta.objectIds/_meta.actorIds を見る(→ ADR-0020)。
	// このテストでは denormalizations.ts のトリガーが動かないため、トリガーが計算するはずの
	// 値を _meta にあらかじめ与えている(get-followers.spec.ts と同じ方針)。
	describe('findActivityByCollectionAndObjectId', () => {
		test('finds a Follow activity by collection and object id', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/follow-1',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: {
					collection: ['https://example.com/following'],
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});

			const found = await store.findActivityByCollectionAndObjectId(
				'https://example.com/following',
				'https://example.com/users/hakatashi',
				true,
			);
			expect(found?.id).toBe('https://example.com/activities/follow-1');
		});

		test('finds a Follow activity whose object is an embedded object rather than a bare IRI', async () => {
			// AS2 の object は IRI 文字列だけでなく埋め込みオブジェクトにもなりうる
			// (実際に dev 環境の Undo(Follow) で観測されたケース、Issue #49 のフォローアップ)。
			// _meta.objectIds は denormalizations.ts がどちらの表現からも同じ値に正規化する。
			await store.saveActivity({
				id: 'https://example.com/activities/follow-embedded',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: [{ id: 'https://example.com/users/hakatashi', type: 'Person' }],
				_meta: {
					collection: ['https://example.com/following'],
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});

			const found = await store.findActivityByCollectionAndObjectId(
				'https://example.com/following',
				'https://example.com/users/hakatashi',
				true,
			);
			expect(found?.id).toBe('https://example.com/activities/follow-embedded');
		});

		test('returns undefined when the object id matches but the collection does not', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/follow-2',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: {
					collection: ['https://example.com/followers'],
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});

			expect(
				await store.findActivityByCollectionAndObjectId(
					'https://example.com/following',
					'https://example.com/users/hakatashi',
					true,
				),
			).toBeUndefined();
		});

		test('returns undefined when nothing matches the object id', async () => {
			expect(
				await store.findActivityByCollectionAndObjectId(
					'https://example.com/following',
					'https://example.com/users/nobody',
					true,
				),
			).toBeUndefined();
		});

		test('strips _meta by default', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/follow-3',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: {
					collection: ['https://example.com/following'],
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});

			const found = await store.findActivityByCollectionAndObjectId(
				'https://example.com/following',
				'https://example.com/users/hakatashi',
			);
			expect(found).not.toHaveProperty('_meta');
		});
	});

	describe('findActivityByCollectionAndActorId', () => {
		test('finds a Follow activity by collection and actor id', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/follow-4',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: {
					collection: ['https://example.com/followers'],
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});

			const found = await store.findActivityByCollectionAndActorId(
				'https://example.com/followers',
				'https://remote.example/u/alice',
				true,
			);
			expect(found?.id).toBe('https://example.com/activities/follow-4');
		});

		test('finds a Follow activity whose actor is an embedded object rather than a bare IRI', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/follow-4-embedded',
				type: 'Follow',
				actor: [{ id: 'https://remote.example/u/alice', type: 'Person' }],
				object: ['https://example.com/users/hakatashi'],
				_meta: {
					collection: ['https://example.com/followers'],
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});

			const found = await store.findActivityByCollectionAndActorId(
				'https://example.com/followers',
				'https://remote.example/u/alice',
				true,
			);
			expect(found?.id).toBe('https://example.com/activities/follow-4-embedded');
		});

		test('returns undefined when the actor id matches but the collection does not', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/follow-5',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: {
					collection: ['https://example.com/following'],
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});

			expect(
				await store.findActivityByCollectionAndActorId(
					'https://example.com/followers',
					'https://remote.example/u/alice',
					true,
				),
			).toBeUndefined();
		});

		test('returns undefined when nothing matches the actor id', async () => {
			expect(
				await store.findActivityByCollectionAndActorId(
					'https://example.com/followers',
					'https://remote.example/u/nobody',
					true,
				),
			).toBeUndefined();
		});
	});

	describe('getStream', () => {
		test('filters by _meta.collection using array-contains', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/in-inbox',
				type: 'Create',
				_meta: { collection: ['https://example.com/inbox'] },
			});
			await store.saveActivity({
				id: 'https://example.com/activities/in-outbox',
				type: 'Create',
				_meta: { collection: ['https://example.com/outbox'] },
			});

			const stream = await store.getStream('https://example.com/inbox', null, null);
			expect(stream).toHaveLength(1);
			expect(stream[0].id).toBe('https://example.com/activities/in-inbox');
			expect(stream[0]._meta.collection).toEqual(['https://example.com/inbox']);
		});

		test('returns an activity that belongs to multiple collections for each of them', async () => {
			// apex は1つのアクティビティが複数のコレクションに所属することを前提にしている
			// (例: 受理済み Follow は inbox と followers の両方に所属する)。
			await store.saveActivity({
				id: 'https://example.com/activities/in-both',
				type: 'Follow',
				_meta: { collection: ['https://example.com/inbox', 'https://example.com/followers'] },
			});

			const inboxStream = await store.getStream('https://example.com/inbox', null, null);
			const followersStream = await store.getStream('https://example.com/followers', null, null);
			expect(inboxStream).toHaveLength(1);
			expect(followersStream).toHaveLength(1);
			expect(inboxStream[0].id).toBe('https://example.com/activities/in-both');
			expect(followersStream[0].id).toBe('https://example.com/activities/in-both');
		});

		test('respects the limit argument', async () => {
			await Promise.all(
				['1', '2', '3'].map((suffix) =>
					store.saveActivity({
						id: `https://example.com/activities/limit-${suffix}`,
						type: 'Create',
						_meta: { collection: ['https://example.com/inbox'] },
					}),
				),
			);

			const stream = await store.getStream('https://example.com/inbox', 2, null);
			expect(stream).toHaveLength(2);
		});

		test('includes the Firestore document ID as _id for use as a pagination cursor', async () => {
			await store.saveActivity({
				id: 'https://example.com/activities/cursor-check',
				type: 'Create',
				_meta: { collection: ['https://example.com/inbox'] },
			});

			const stream = await store.getStream('https://example.com/inbox', null, null);
			expect(stream).toHaveLength(1);
			expect(typeof stream[0]._id).toBe('string');
			expect(stream[0]._id.length).toBeGreaterThan(0);
		});

		test('pages through a collection using the _id cursor without duplicates or gaps', async () => {
			await Promise.all(
				['1', '2', '3', '4', '5'].map((suffix) =>
					store.saveActivity({
						id: `https://example.com/activities/page-${suffix}`,
						type: 'Create',
						_meta: { collection: ['https://example.com/inbox'] },
					}),
				),
			);

			const collected: string[] = [];
			let after: string | null = null;
			for (let i = 0; i < 10; i++) {
				const page: any[] = await store.getStream('https://example.com/inbox', 2, after);
				if (page.length === 0) {
					break;
				}
				collected.push(...page.map((activity) => activity.id));
				after = page.at(-1)._id;
			}

			expect(collected).toHaveLength(5);
			expect(new Set(collected).size).toBe(5);
			expect(new Set(collected)).toEqual(
				new Set([
					'https://example.com/activities/page-1',
					'https://example.com/activities/page-2',
					'https://example.com/activities/page-3',
					'https://example.com/activities/page-4',
					'https://example.com/activities/page-5',
				]),
			);
		});

		test('limit === null (page === Infinity) still returns every matching activity', async () => {
			await Promise.all(
				['1', '2', '3'].map((suffix) =>
					store.saveActivity({
						id: `https://example.com/activities/all-${suffix}`,
						type: 'Create',
						_meta: { collection: ['https://example.com/inbox'] },
					}),
				),
			);

			const stream = await store.getStream('https://example.com/inbox', null, null);
			expect(stream).toHaveLength(3);
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
				_meta: { collection: ['https://example.com/inbox'] },
			});

			await expect(
				store.getStream('https://example.com/inbox', null, null, [
					'https://example.com/users/blocked',
				]),
			).rejects.toThrow('order by clause cannot contain more fields after the key');
		});
	});

	describe('updateActivityMeta', () => {
		// MongoDB 実装(activitypub-express/store/index.js)は $addToSet / $pull を使い、
		// 追加であって上書きではない。Firestore Store も同じ意味論にする必要がある (→ ADR-0017)。
		test('adds a value to _meta.collection without overwriting existing entries', async () => {
			const activity = {
				id: 'https://example.com/activities/accepted-follow',
				type: 'Follow',
				_meta: { collection: ['https://example.com/inbox'] },
			};
			await store.saveActivity(activity);

			await store.updateActivityMeta(
				activity,
				'collection',
				'https://example.com/followers',
				false,
			);

			const fetched = await store.getActivity(activity.id, true);
			expect(fetched?._meta.collection).toEqual(
				expect.arrayContaining(['https://example.com/inbox', 'https://example.com/followers']),
			);
			expect(fetched?._meta.collection).toHaveLength(2);
		});

		test('does not add a duplicate when the value is already present', async () => {
			const activity = {
				id: 'https://example.com/activities/duplicate',
				type: 'Create',
				_meta: { collection: ['https://example.com/inbox'] },
			};
			await store.saveActivity(activity);

			await store.updateActivityMeta(activity, 'collection', 'https://example.com/inbox', false);

			const fetched = await store.getActivity(activity.id, true);
			expect(fetched?._meta.collection).toEqual(['https://example.com/inbox']);
		});

		test('removes only the given value, leaving other collections intact', async () => {
			const activity = {
				id: 'https://example.com/activities/removable-meta',
				type: 'Follow',
				_meta: { collection: ['https://example.com/inbox', 'https://example.com/followers'] },
			};
			await store.saveActivity(activity);

			await store.updateActivityMeta(activity, 'collection', 'https://example.com/followers', true);

			const fetched = await store.getActivity(activity.id, true);
			expect(fetched?._meta.collection).toEqual(['https://example.com/inbox']);
		});

		test('throws when the activity does not exist', async () => {
			await expect(
				store.updateActivityMeta(
					{ id: 'https://example.com/activities/missing' },
					'collection',
					'https://example.com/inbox',
					false,
				),
			).rejects.toThrow('Error updating activity meta: not found');
		});
	});

	describe('removeActivity', () => {
		test('removes an activity attributed to the given actor', async () => {
			// removeActivity は _meta.actorIds (denormalizations.ts が書き込む) で絞り込むため、
			// トリガーが動かないこのテストではあらかじめ値を与えている(→ ADR-0020)。
			const activity = {
				id: 'https://example.com/activities/removable',
				type: 'Create',
				actor: ['https://example.com/users/actor'],
				_meta: { actorIds: ['https://example.com/users/actor'] },
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
				activityId,
				actorId,
				address,
				body,
				attempts: 1,
				status: 'success',
				statusCode: 202,
			});

			const delivery = await store.getDelivery(activityId, address);
			expect(delivery).toMatchObject({
				activityId,
				actorId,
				inbox: address,
				body,
				attempts: 1,
				status: 'success',
				statusCode: 202,
				error: null,
			});
		});

		test('overwrites the previous record for the same activity/address pair', async () => {
			await store.recordDeliveryResult({
				activityId,
				actorId,
				address,
				body,
				attempts: 1,
				status: 'retrying',
				statusCode: 503,
				error: 'boom',
			});
			await store.recordDeliveryResult({
				activityId,
				actorId,
				address,
				body,
				attempts: 2,
				status: 'success',
				statusCode: 202,
			});

			const delivery = await store.getDelivery(activityId, address);
			expect(delivery).toMatchObject({ attempts: 2, status: 'success', error: null });
		});

		test('getDelivery returns undefined for an unknown pair', async () => {
			expect(await store.getDelivery(activityId, address)).toBeUndefined();
		});

		test('getFailedDeliveries lists only permanent_failure and retrying deliveries', async () => {
			await store.recordDeliveryResult({
				activityId,
				actorId,
				address,
				body,
				attempts: 1,
				status: 'success',
				statusCode: 202,
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
			expect(failed.map((delivery) => delivery.status).sort()).toEqual([
				'permanent_failure',
				'retrying',
			]);
		});
	});
});
