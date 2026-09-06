import assert from 'node:assert';
import type { DocumentReference, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { onStreamCreated, onStreamWritten } from '../../src/denormalizations.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { Streams, UserInfos } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const getData = async <T>(ref: DocumentReference<T>): Promise<T> => {
	const data = (await ref.get()).data();
	assert(data !== undefined, `document ${ref.path} does not exist`);
	return data;
};

const makeWrittenEvent = (data: unknown) =>
	data as unknown as Parameters<typeof onStreamWritten.run>[0];

const makeCreatedEvent = (data: unknown) =>
	data as unknown as Parameters<typeof onStreamCreated.run>[0];

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

	// onStreamWritten は streams コレクションの書き込みを検知し、_meta.collection /
	// actor / object から _meta.index.* を計算して書き戻す(→ ADR-0021)。
	// Store (store.ts) の findActivityByCollectionAndObjectId / findActivityByCollectionAndActorId は
	// この _meta.index.* を等価条件で引く。collection/actor/object は IRI 文字列・Link・
	// 埋め込みオブジェクトのいずれにもなりうるため、どの表現でも同じキーに正規化されることを確認する。
	describe('onStreamWritten', () => {
		test('denormalizes _meta.index from _meta.collection and bare IRI strings', async () => {
			const ref = Streams.doc(escapeFirestoreKey('stream-1'));
			await ref.set({
				id: 'https://example.com/activities/1',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: { collection: ['https://example.com/activitypub/u/hakatashi/inbox'] },
			});
			const after = await ref.get();

			await onStreamWritten.run(makeWrittenEvent({ data: { before: undefined, after } }));

			const updated = await getData(ref);
			expect(updated._meta.index).toEqual({
				collections: {
					[escapeFirestoreKey('https://example.com/activitypub/u/hakatashi/inbox')]: true,
				},
				actors: { [escapeFirestoreKey('https://remote.example/u/alice')]: true },
				objects: { [escapeFirestoreKey('https://example.com/users/hakatashi')]: true },
			});
		});

		test('denormalizes _meta.index from embedded objects and Links', async () => {
			// dev 環境で実際に観測された Undo(Follow) は object が埋め込みオブジェクトになる
			// (Issue #49 のフォローアップ)。Link (href が配列でボックス化される) も含めて
			// スカラーの IRI 文字列に正規化されることを確認する。
			const ref = Streams.doc(escapeFirestoreKey('stream-2'));
			await ref.set({
				id: 'https://example.com/activities/2',
				type: 'Follow',
				actor: [{ id: 'https://remote.example/u/alice', type: 'Person' }],
				object: [{ type: 'Link', href: ['https://example.com/users/hakatashi'] }],
			});
			const after = await ref.get();

			await onStreamWritten.run(makeWrittenEvent({ data: { before: undefined, after } }));

			const updated = await getData(ref);
			expect(updated._meta.index.actors).toEqual({
				[escapeFirestoreKey('https://remote.example/u/alice')]: true,
			});
			expect(updated._meta.index.objects).toEqual({
				[escapeFirestoreKey('https://example.com/users/hakatashi')]: true,
			});
		});

		// IRI はドットを含むため、エスケープせずに map のキーにすると Firestore の
		// フィールドパスの区切りと衝突する (→ ADR-0021)。
		test('escapes dots and slashes in the index keys', async () => {
			const ref = Streams.doc(escapeFirestoreKey('stream-3'));
			await ref.set({
				id: 'https://example.com/activities/3',
				type: 'Create',
				object: ['https://mstdn.jp/users/hakatashi/statuses/1'],
			});
			const after = await ref.get();

			await onStreamWritten.run(makeWrittenEvent({ data: { before: undefined, after } }));

			const updated = await getData(ref);
			expect(Object.keys(updated._meta.index.objects)).toEqual([
				'https:%2F%2Fmstdn%2Ejp%2Fusers%2Fhakatashi%2Fstatuses%2F1',
			]);
		});

		test('does not write when the index is already up to date', async () => {
			const ref = Streams.doc(escapeFirestoreKey('stream-4'));
			const index = {
				collections: {},
				actors: { [escapeFirestoreKey('https://remote.example/u/alice')]: true },
				objects: { [escapeFirestoreKey('https://example.com/users/hakatashi')]: true },
			};
			await ref.set({
				id: 'https://example.com/activities/4',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/users/hakatashi'],
				_meta: { index },
			});
			const after = await ref.get();

			// Should not throw even though no update is necessary
			await expect(
				onStreamWritten.run(makeWrittenEvent({ data: { before: undefined, after } })),
			).resolves.toBeUndefined();

			const updated = await getData(ref);
			expect(updated._meta).toEqual({ index });
		});

		test('does nothing when the document was deleted', async () => {
			await expect(
				onStreamWritten.run(
					makeWrittenEvent({
						data: { before: undefined, after: { data: () => undefined } },
					}),
				),
			).resolves.toBeUndefined();
		});

		test('writes empty maps when the activity has no actor/object/collection', async () => {
			const ref = Streams.doc(escapeFirestoreKey('stream-5'));
			await ref.set({ id: 'https://example.com/activities/5', type: 'Follow' });
			const after = await ref.get();

			await onStreamWritten.run(makeWrittenEvent({ data: { before: undefined, after } }));

			const updated = await getData(ref);
			expect(updated._meta.index).toEqual({ collections: {}, actors: {}, objects: {} });
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

			const ref = Streams.doc(escapeFirestoreKey('note-stream'));
			await ref.set({
				id: 'https://example.com/activities/note-1',
				type: 'Create',
				actor: [actorId],
				object: [{ type: 'Note' }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

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

			const ref = Streams.doc(escapeFirestoreKey('follow-stream'));
			await ref.set({
				id: 'https://example.com/activities/follow-1',
				type: 'Follow',
				actor: [followerId],
				object: [followedId],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

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

			const ref = Streams.doc(escapeFirestoreKey('undo-stream'));
			await ref.set({
				id: 'https://example.com/activities/undo-1',
				type: 'Undo',
				actor: [followerId],
				object: [{ type: 'Follow', object: [followedId] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

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

			const ref = Streams.doc(escapeFirestoreKey('undo-stream-embedded'));
			await ref.set({
				id: 'https://example.com/activities/undo-2',
				type: 'Undo',
				actor: [followerId],
				object: [{ type: 'Follow', object: [{ id: followedId, type: 'Person' }] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await expect(
				onStreamCreated.run(makeCreatedEvent({ data: snapshot })),
			).resolves.toBeUndefined();

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

			const ref = Streams.doc(escapeFirestoreKey('note-stream-embedded'));
			await ref.set({
				id: 'https://example.com/activities/note-2',
				type: 'Create',
				actor: [{ id: actorId, type: 'Person' }],
				object: [{ type: 'Note' }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await expect(
				onStreamCreated.run(makeCreatedEvent({ data: snapshot })),
			).resolves.toBeUndefined();

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(6);
		});

		test('increments statuses_count when the Note object has type as an array (compactArrays: false)', async () => {
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

			const ref = Streams.doc(escapeFirestoreKey('note-stream-array-type'));
			await ref.set({
				id: 'https://example.com/activities/note-array',
				type: ['Create'],
				actor: [actorId],
				object: [{ type: ['Note'] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(6);
		});

		test('does not increment statuses_count when object is a bare IRI rather than an embedded Note', async () => {
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

			const ref = Streams.doc(escapeFirestoreKey('note-stream-bare-iri'));
			await ref.set({
				id: 'https://example.com/activities/note-bare',
				type: 'Create',
				actor: [actorId],
				object: ['https://example.com/notes/1'],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(5);
		});

		test('decrements followers_count when stream.type is an array and object.type is an array', async () => {
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

			const ref = Streams.doc(escapeFirestoreKey('undo-stream-array-types'));
			await ref.set({
				id: 'https://example.com/activities/undo-array',
				type: ['Undo'],
				actor: [followerId],
				object: [{ type: ['Follow'], object: [followedId] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(followedId)));
			expect(userInfo.followers_count).toBe(2);
		});

		test('does nothing when the document was deleted', async () => {
			await expect(
				onStreamCreated.run(makeCreatedEvent({ data: { data: () => undefined } })),
			).resolves.toBeUndefined();
		});
	});
});
