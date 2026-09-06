import assert from 'node:assert';
import type { DocumentReference, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { onStreamCreated, onStreamWritten } from '../../src/denormalizations.js';
import { db, escapeFirestoreKey } from '../../src/firebase.js';
import { UserInfos } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const getData = async <T>(ref: DocumentReference<T>): Promise<T> => {
	const data = (await ref.get()).data();
	assert(data !== undefined, `document ${ref.path} does not exist`);
	return data;
};

// firebase-functions v2 の onDocumentWritten / onDocumentCreated が返す関数は
// `.run(event)` として元のハンドラをそのまま呼び出せる
// (node_modules/firebase-functions/lib/v2/providers/firestore.js の `func.run = handler`)。
// これを使い、Firestore エミュレータ上の実ドキュメントから CloudEvent 相当のオブジェクトを
// 組み立ててトリガーのロジックだけを直接検証する。
describe('denormalizations', () => {
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

	describe('onStreamWritten', () => {
		test('denormalizes _meta.objectTypes and _meta.objectType from the current object field', async () => {
			const ref = db.collection('streams').doc('stream-1');
			await ref.set({
				id: 'https://example.com/activities/1',
				type: 'Create',
				object: [{ type: 'Note' }],
			});
			const after = await ref.get();

			await onStreamWritten.run({ data: { before: undefined, after } } as any);

			const updated = await getData(ref);
			expect(updated._meta.objectTypes).toEqual(['Note']);
			expect(updated._meta.objectType).toBe('Note');
		});

		test('does not write when the denormalized fields are already up to date', async () => {
			const ref = db.collection('streams').doc('stream-2');
			await ref.set({
				id: 'https://example.com/activities/2',
				type: 'Create',
				object: [{ type: 'Note' }],
				_meta: { objectTypes: ['Note'], objectType: 'Note' },
			});
			const after = await ref.get();

			// Should not throw even though no update is necessary
			await expect(
				onStreamWritten.run({ data: { before: undefined, after } } as any),
			).resolves.toBeUndefined();

			const updated = await getData(ref);
			expect(updated._meta).toEqual({ objectTypes: ['Note'], objectType: 'Note' });
		});

		test('does nothing when the document was deleted', async () => {
			await expect(
				onStreamWritten.run({
					data: { before: undefined, after: { data: () => undefined } },
				} as any),
			).resolves.toBeUndefined();
		});

		test('treats a missing object field as an empty collection and skips the update since nothing changed', async () => {
			const ref = db.collection('streams').doc('stream-3');
			await ref.set({ id: 'https://example.com/activities/3', type: 'Follow' });
			const after = await ref.get();

			await onStreamWritten.run({ data: { before: undefined, after } } as any);

			const updated = await getData(ref);
			expect(updated._meta).toBeUndefined();
		});

		// findActivityByCollectionAndActorId/ObjectId (→ ADR-0020) はこの _meta.actorIds/objectIds を
		// array-contains で引く。actor/object は IRI 文字列・Link・埋め込みオブジェクトのいずれにも
		// なりうるため、どの表現でも同じ ID に正規化されることを確認する。
		test('denormalizes _meta.actorIds and _meta.objectIds from bare IRI strings', async () => {
			const ref = db.collection('streams').doc('stream-4');
			await ref.set({
				id: 'https://example.com/activities/4',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
			});
			const after = await ref.get();

			await onStreamWritten.run({ data: { before: undefined, after } } as any);

			const updated = await getData(ref);
			expect(updated._meta.actorIds).toEqual(['https://remote.example/u/alice']);
			expect(updated._meta.objectIds).toEqual(['https://example.com/users/hakatashi']);
		});

		test('denormalizes _meta.actorIds and _meta.objectIds from embedded objects and Links', async () => {
			// dev 環境で実際に観測された Undo(Follow) は object が埋め込みオブジェクトになる
			// (Issue #49 のフォローアップ)。Link (href が配列でボックス化される) も含めて
			// スカラーの IRI 文字列に正規化されることを確認する。
			const ref = db.collection('streams').doc('stream-5');
			await ref.set({
				id: 'https://example.com/activities/5',
				type: 'Follow',
				actor: [{ id: 'https://remote.example/u/alice', type: 'Person' }],
				object: [{ type: 'Link', href: ['https://example.com/users/hakatashi'] }],
			});
			const after = await ref.get();

			await onStreamWritten.run({ data: { before: undefined, after } } as any);

			const updated = await getData(ref);
			expect(updated._meta.actorIds).toEqual(['https://remote.example/u/alice']);
			expect(updated._meta.objectIds).toEqual(['https://example.com/users/hakatashi']);
		});

		test('does not write _meta.actorIds/objectIds when already up to date', async () => {
			const ref = db.collection('streams').doc('stream-6');
			await ref.set({
				id: 'https://example.com/activities/6',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: {
					actorIds: ['https://remote.example/u/alice'],
					objectIds: ['https://example.com/users/hakatashi'],
				},
			});
			const after = await ref.get();

			await expect(
				onStreamWritten.run({ data: { before: undefined, after } } as any),
			).resolves.toBeUndefined();

			const updated = await getData(ref);
			expect(updated._meta).toEqual({
				actorIds: ['https://remote.example/u/alice'],
				objectIds: ['https://example.com/users/hakatashi'],
			});
		});
	});

	describe('onStreamCreated', () => {
		test('increments statuses_count when a Note stream is created', async () => {
			const actorId = 'https://example.com/activitypub/u/hakatashi';
			await UserInfos.doc(escapeFirestoreKey(actorId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: 0,
				following_count: 0,
				statuses_count: 5,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

			const ref = db.collection('streams').doc('note-stream');
			await ref.set({
				id: 'https://example.com/activities/note-1',
				type: 'Create',
				actor: [actorId],
				object: [{ type: 'Note' }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run({ data: snapshot } as any);

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(6);
		});

		test('increments followers_count of the followed actor when a Follow stream is created', async () => {
			const followerId = 'https://example.com/activitypub/u/follower';
			const followedId = 'https://example.com/activitypub/u/hakatashi';
			await UserInfos.doc(escapeFirestoreKey(followedId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: 3,
				following_count: 0,
				statuses_count: 0,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

			const ref = db.collection('streams').doc('follow-stream');
			await ref.set({
				id: 'https://example.com/activities/follow-1',
				type: 'Follow',
				actor: [followerId],
				object: [followedId],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run({ data: snapshot } as any);

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(followedId)));
			expect(userInfo.followers_count).toBe(4);
		});

		test('decrements followers_count when an Undo Follow stream is created', async () => {
			const followerId = 'https://example.com/activitypub/u/follower';
			const followedId = 'https://example.com/activitypub/u/hakatashi';
			await UserInfos.doc(escapeFirestoreKey(followedId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: 3,
				following_count: 0,
				statuses_count: 0,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

			const ref = db.collection('streams').doc('undo-stream');
			await ref.set({
				id: 'https://example.com/activities/undo-1',
				type: 'Undo',
				actor: [followerId],
				object: [{ type: 'Follow', object: [followedId] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run({ data: snapshot } as any);

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(followedId)));
			expect(userInfo.followers_count).toBe(2);
		});

		test('decrements followers_count when the Undo(Follow) target is an embedded object rather than a bare IRI', async () => {
			// AS2 の object は IRI 文字列だけでなく埋め込みオブジェクトにもなりうる。
			// toIdArray を介さず直接 escapeFirestoreKey に渡すと例外になっていた(Issue #49 のフォローアップ)。
			const followerId = 'https://example.com/activitypub/u/follower';
			const followedId = 'https://example.com/activitypub/u/hakatashi';
			await UserInfos.doc(escapeFirestoreKey(followedId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: 3,
				following_count: 0,
				statuses_count: 0,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

			const ref = db.collection('streams').doc('undo-stream-embedded');
			await ref.set({
				id: 'https://example.com/activities/undo-2',
				type: 'Undo',
				actor: [followerId],
				object: [{ type: 'Follow', object: [{ id: followedId, type: 'Person' }] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await expect(onStreamCreated.run({ data: snapshot } as any)).resolves.toBeUndefined();

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(followedId)));
			expect(userInfo.followers_count).toBe(2);
		});

		test('does not crash when the actor of a Note stream is an embedded object rather than a bare IRI', async () => {
			const actorId = 'https://example.com/activitypub/u/hakatashi';
			await UserInfos.doc(escapeFirestoreKey(actorId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: 0,
				following_count: 0,
				statuses_count: 5,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

			const ref = db.collection('streams').doc('note-stream-embedded');
			await ref.set({
				id: 'https://example.com/activities/note-2',
				type: 'Create',
				actor: [{ id: actorId, type: 'Person' }],
				object: [{ type: 'Note' }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await expect(onStreamCreated.run({ data: snapshot } as any)).resolves.toBeUndefined();

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(6);
		});

		test('does nothing when the document was deleted', async () => {
			await expect(
				onStreamCreated.run({ data: { data: () => undefined } } as any),
			).resolves.toBeUndefined();
		});
	});
});
