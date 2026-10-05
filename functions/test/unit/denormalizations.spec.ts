import assert from 'node:assert';
import type { DocumentReference, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import type { APActor } from 'activitypub-types';
import { apex } from '../../src/activitypub.js';
import { buildMetaIndex } from '../../src/meta.js';
import {
	onStreamCreated,
	onStreamWritten,
	recomputeLocalFollowCounts,
} from '../../src/denormalizations.js';
import { domain, escapeFirestoreKey } from '../../src/firebase.js';
import { Objects, Streams, UserInfos } from '../../src/schema.js';

import { resetFirestore } from '../helpers/index.js';

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
	// Teardown firestore database after each test
	afterEach(async () => {
		await resetFirestore();
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

		test('decrements statuses_count when a Delete stream with Tombstone object is created', async () => {
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

			const ref = Streams.doc(escapeFirestoreKey('delete-tombstone-stream'));
			await ref.set({
				id: 'https://example.com/activities/delete-1',
				type: 'Delete',
				actor: [actorId],
				object: [{ id: 'https://example.com/notes/1', type: 'Tombstone' }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(4);
		});

		test('decrements statuses_count when a Delete stream with Note object is created', async () => {
			const actorId = 'https://example.com/activitypub/u/hakatashi';
			await UserInfos.doc(escapeFirestoreKey(actorId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: 0,
				following_count: 0,
				statuses_count: 3,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

			const ref = Streams.doc(escapeFirestoreKey('delete-note-stream'));
			await ref.set({
				id: 'https://example.com/activities/delete-2',
				type: ['Delete'],
				actor: [actorId],
				object: [{ id: 'https://example.com/notes/2', type: ['Note'] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(2);
		});

		test('does not underflow statuses_count below 0 on Delete stream', async () => {
			const actorId = 'https://example.com/activitypub/u/hakatashi';
			await UserInfos.doc(escapeFirestoreKey(actorId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: 0,
				following_count: 0,
				statuses_count: 0,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

			const ref = Streams.doc(escapeFirestoreKey('delete-underflow-stream'));
			await ref.set({
				id: 'https://example.com/activities/delete-3',
				type: 'Delete',
				actor: [actorId],
				object: [{ id: 'https://example.com/notes/3', type: 'Tombstone' }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(actorId)));
			expect(userInfo.statuses_count).toBe(0);
		});

		test('does nothing when the document was deleted', async () => {
			await expect(
				onStreamCreated.run(makeCreatedEvent({ data: { data: () => undefined } })),
			).resolves.toBeUndefined();
		});

		// Issue #55 の実地検証で、apex 本体の likes/shares コレクション機構が Note のような
		// object を対象にすると機能しない(routes.likes/shares は streams コレクション専用)
		// ことが分かったため、followers_count と同じ非正規化カウンタのパターンで
		// objects._meta.likesCount / sharesCount を直接更新する (→ ADR-0037)。
		test('increments _meta.likesCount of the liked object when a Like stream is created', async () => {
			const noteId = 'https://example.com/activitypub/o/note-1';
			await Objects.doc(escapeFirestoreKey(noteId)).set({
				id: noteId,
				type: 'Note',
				_meta: { likesCount: 2 },
			});

			const ref = Streams.doc(escapeFirestoreKey('like-stream'));
			await ref.set({
				id: 'https://remote.example/activities/like-1',
				type: 'Like',
				actor: ['https://remote.example/u/alice'],
				object: [noteId],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const note = await getData(Objects.doc(escapeFirestoreKey(noteId)));
			expect(note._meta?.likesCount).toBe(3);
		});

		// apex 本体の activity.save は Like/Announce にも解決済みの object を埋め込んで
		// 保存する(ADR-0038 で Like/Announce の object 解決が成功するようになった結果、
		// 実際に dev 環境で観測した)。embed された object の型だけで statuses_count の
		// 対象を判定すると、いいねした側(_meta.likesCount の更新とは無関係な第三者の
		// UserInfos)を誤って更新しようとして batch 全体が失敗し、likesCount の更新も
		// 巻き添えで失われていた (→ ADR-0039)。
		test('increments _meta.likesCount without touching statuses_count when the Like embeds a Note object', async () => {
			const noteId = 'https://example.com/activitypub/o/note-embedded';
			await Objects.doc(escapeFirestoreKey(noteId)).set({ id: noteId, type: 'Note' });

			const likerId = 'https://remote.example/u/alice';
			// リモートの liker は UserInfos ドキュメントを持たない(単一ユーザー運用のため)。
			// もし statuses_count の更新が誤って走れば、存在しないドキュメントへの
			// batch.update() で例外になり、likesCount の更新も失われる。
			const ref = Streams.doc(escapeFirestoreKey('like-stream-embedded'));
			await ref.set({
				id: 'https://remote.example/activities/like-embedded',
				type: 'Like',
				actor: [likerId],
				object: [{ id: noteId, type: 'Note', attributedTo: ['https://example.com/u/hakatashi'] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await expect(
				onStreamCreated.run(makeCreatedEvent({ data: snapshot })),
			).resolves.toBeUndefined();

			const note = await getData(Objects.doc(escapeFirestoreKey(noteId)));
			expect(note._meta?.likesCount).toBe(1);

			const likerInfo = await UserInfos.doc(escapeFirestoreKey(likerId)).get();
			expect(likerInfo.exists).toBe(false);
		});

		test('increments _meta.sharesCount of the shared object when an Announce stream is created', async () => {
			const noteId = 'https://example.com/activitypub/o/note-2';
			await Objects.doc(escapeFirestoreKey(noteId)).set({ id: noteId, type: 'Note' });

			const ref = Streams.doc(escapeFirestoreKey('announce-stream'));
			await ref.set({
				id: 'https://remote.example/activities/announce-1',
				type: 'Announce',
				actor: ['https://remote.example/u/alice'],
				object: [noteId],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const note = await getData(Objects.doc(escapeFirestoreKey(noteId)));
			expect(note._meta?.sharesCount).toBe(1);
		});

		test('decrements _meta.likesCount when an Undo(Like) stream is created', async () => {
			const noteId = 'https://example.com/activitypub/o/note-3';
			await Objects.doc(escapeFirestoreKey(noteId)).set({
				id: noteId,
				type: 'Note',
				_meta: { likesCount: 1 },
			});

			const ref = Streams.doc(escapeFirestoreKey('undo-like-stream'));
			await ref.set({
				id: 'https://remote.example/activities/undo-like-1',
				type: 'Undo',
				actor: ['https://remote.example/u/alice'],
				object: [{ type: 'Like', object: [noteId] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const note = await getData(Objects.doc(escapeFirestoreKey(noteId)));
			expect(note._meta?.likesCount).toBe(0);
		});

		test('decrements _meta.sharesCount when an Undo(Announce) stream is created', async () => {
			const noteId = 'https://example.com/activitypub/o/note-4';
			await Objects.doc(escapeFirestoreKey(noteId)).set({
				id: noteId,
				type: 'Note',
				_meta: { sharesCount: 1 },
			});

			const ref = Streams.doc(escapeFirestoreKey('undo-announce-stream'));
			await ref.set({
				id: 'https://remote.example/activities/undo-announce-1',
				type: 'Undo',
				actor: ['https://remote.example/u/alice'],
				object: [{ type: 'Announce', object: [noteId] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const note = await getData(Objects.doc(escapeFirestoreKey(noteId)));
			expect(note._meta?.sharesCount).toBe(0);
		});

		test('does not decrement _meta.likesCount below 0 when Undo(Like) is received without prior like', async () => {
			const noteId = 'https://example.com/activitypub/o/note-underflow-like';
			await Objects.doc(escapeFirestoreKey(noteId)).set({
				id: noteId,
				type: 'Note',
			});

			const ref = Streams.doc(escapeFirestoreKey('undo-like-underflow-stream'));
			await ref.set({
				id: 'https://remote.example/activities/undo-like-underflow',
				type: 'Undo',
				actor: ['https://remote.example/u/alice'],
				object: [{ type: 'Like', object: [noteId] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const note = await getData(Objects.doc(escapeFirestoreKey(noteId)));
			expect(note._meta?.likesCount).toBe(0);
		});

		test('does not decrement _meta.sharesCount below 0 when Undo(Announce) is received without prior announce', async () => {
			const noteId = 'https://example.com/activitypub/o/note-underflow-announce';
			await Objects.doc(escapeFirestoreKey(noteId)).set({
				id: noteId,
				type: 'Note',
			});

			const ref = Streams.doc(escapeFirestoreKey('undo-announce-underflow-stream'));
			await ref.set({
				id: 'https://remote.example/activities/undo-announce-underflow',
				type: 'Undo',
				actor: ['https://remote.example/u/alice'],
				object: [{ type: 'Announce', object: [noteId] }],
			});
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamCreated.run(makeCreatedEvent({ data: snapshot }));

			const note = await getData(Objects.doc(escapeFirestoreKey(noteId)));
			expect(note._meta?.sharesCount).toBe(0);
		});
	});

	// フォロー数は差分ではなく、フォロワー/フォロー一覧と同じ基準で数え直す (→ ADR-0075)。
	describe('recomputeLocalFollowCounts', () => {
		const localId = `https://${domain}/activitypub/u/hakatashi`;
		const localActor = {
			id: localId,
			type: 'Person',
			preferredUsername: 'hakatashi',
			inbox: `${localId}/inbox`,
		} as unknown as APActor;

		const setUserInfo = (followers: number, following: number) =>
			UserInfos.doc(escapeFirestoreKey(localId)).set({
				id: '1',
				uid: 'firebase-uid',
				locked: false,
				bot: false,
				created_at: '2023-01-01T00:00:00.000Z',
				followers_count: followers,
				following_count: following,
				statuses_count: 0,
				last_status_at: '',
				emojis: [],
				fields: [],
				roles: [],
			});

		const saveStream = (docId: string, activity: Record<string, unknown>) =>
			Streams.doc(escapeFirestoreKey(docId)).set({
				...activity,
				_meta: { ...(activity._meta as object), index: buildMetaIndex(activity) },
			} as never);

		beforeEach(async () => {
			await apex.store.saveObject(localActor);
		});

		test('counts each follower once even when the same actor has sent multiple Follows', async () => {
			await setUserInfo(19, 0);
			for (const n of [1, 2]) {
				await saveStream(`follow-alice-${n}`, {
					id: `https://remote.example/activities/follow-alice-${n}`,
					type: 'Follow',
					actor: ['https://remote.example/u/alice'],
					object: [localId],
				});
			}
			await saveStream('follow-bob', {
				id: 'https://remote.example/activities/follow-bob',
				type: 'Follow',
				actor: ['https://remote.example/u/bob'],
				object: [localId],
			});

			await recomputeLocalFollowCounts();

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(localId)));
			expect(userInfo.followers_count).toBe(2);
		});

		test('counts only accepted outgoing Follows as following_count', async () => {
			await setUserInfo(0, 0);
			const accepted = 'https://remote.example/activities/follow-accepted';
			await saveStream('follow-accepted', {
				id: accepted,
				type: 'Follow',
				actor: [localId],
				object: ['https://remote.example/u/alice'],
			});
			await saveStream('follow-pending', {
				id: 'https://remote.example/activities/follow-pending',
				type: 'Follow',
				actor: [localId],
				object: ['https://remote.example/u/bob'],
			});
			await saveStream('accept-alice', {
				id: 'https://remote.example/activities/accept-alice',
				type: 'Accept',
				actor: ['https://remote.example/u/alice'],
				object: [accepted],
				_meta: { collection: [localActor.inbox] },
			});

			await recomputeLocalFollowCounts();

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(localId)));
			expect(userInfo.following_count).toBe(1);
			expect(userInfo.followers_count).toBe(0);
		});

		test('is refreshed by onStreamWritten for a Follow stream', async () => {
			await setUserInfo(5, 0);
			const ref = Streams.doc(escapeFirestoreKey('follow-written'));
			await ref.set({
				id: 'https://remote.example/activities/follow-written',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: [localId],
			} as never);
			const snapshot = (await ref.get()) as QueryDocumentSnapshot;

			await onStreamWritten.run(makeWrittenEvent({ data: { before: undefined, after: snapshot } }));

			const userInfo = await getData(UserInfos.doc(escapeFirestoreKey(localId)));
			expect(userInfo.followers_count).toBe(1);
		});
	});
});
