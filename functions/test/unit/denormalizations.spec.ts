import type {QueryDocumentSnapshot} from 'firebase-admin/firestore';
import {describe, expect, test, afterEach, beforeEach} from 'vitest';
import {onStreamCreated, onStreamWritten} from '../../src/denormalizations.js';
import {db, escapeFirestoreKey} from '../../src/firebase.js';
import {UserInfos} from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

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
				object: [{type: 'Note'}],
			});
			const after = await ref.get();

			await onStreamWritten.run({data: {before: undefined, after}} as any);

			const updated = (await ref.get()).data()!;
			expect(updated._meta.objectTypes).toEqual(['Note']);
			expect(updated._meta.objectType).toBe('Note');
		});

		test('does not write when the denormalized fields are already up to date', async () => {
			const ref = db.collection('streams').doc('stream-2');
			await ref.set({
				id: 'https://example.com/activities/2',
				type: 'Create',
				object: [{type: 'Note'}],
				_meta: {objectTypes: ['Note'], objectType: 'Note'},
			});
			const after = await ref.get();

			// Should not throw even though no update is necessary
			await expect(onStreamWritten.run({data: {before: undefined, after}} as any)).resolves.toBeUndefined();

			const updated = (await ref.get()).data()!;
			expect(updated._meta).toEqual({objectTypes: ['Note'], objectType: 'Note'});
		});

		test('does nothing when the document was deleted', async () => {
			await expect(onStreamWritten.run({data: {before: undefined, after: {data: () => undefined}}} as any)).resolves.toBeUndefined();
		});

		test('treats a missing object field as an empty collection and skips the update since nothing changed', async () => {
			const ref = db.collection('streams').doc('stream-3');
			await ref.set({id: 'https://example.com/activities/3', type: 'Follow'});
			const after = await ref.get();

			await onStreamWritten.run({data: {before: undefined, after}} as any);

			const updated = (await ref.get()).data()!;
			expect(updated._meta).toBeUndefined();
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
				object: [{type: 'Note'}],
			});
			const snapshot = await ref.get() as QueryDocumentSnapshot;

			await onStreamCreated.run({data: snapshot} as any);

			const userInfo = (await UserInfos.doc(escapeFirestoreKey(actorId)).get()).data()!;
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
			const snapshot = await ref.get() as QueryDocumentSnapshot;

			await onStreamCreated.run({data: snapshot} as any);

			const userInfo = (await UserInfos.doc(escapeFirestoreKey(followedId)).get()).data()!;
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
				object: [{type: 'Follow', object: [followedId]}],
			});
			const snapshot = await ref.get() as QueryDocumentSnapshot;

			await onStreamCreated.run({data: snapshot} as any);

			const userInfo = (await UserInfos.doc(escapeFirestoreKey(followedId)).get()).data()!;
			expect(userInfo.followers_count).toBe(2);
		});

		test('does nothing when the document was deleted', async () => {
			await expect(onStreamCreated.run({data: {data: () => undefined}} as any)).resolves.toBeUndefined();
		});
	});
});
