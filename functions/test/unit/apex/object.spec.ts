import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

describe('apex pub/object resolveObject & resolveUnknown (ADR-0053)', () => {
	const DOMAIN = 'example.com';
	const LOCAL_NOTE_ID = `https://${DOMAIN}/o/note-1`;
	const REMOTE_NOTE_ID = 'https://remote.example/o/note-2';

	const createMockStore = () =>
		({
			getObject: vi.fn().mockResolvedValue(undefined),
			saveObject: vi.fn().mockResolvedValue(true),
			updateObject: vi.fn().mockResolvedValue(true),
			getActivity: vi.fn().mockResolvedValue(undefined),
			saveActivity: vi.fn().mockResolvedValue({ isNew: true, activity: {} }),
			updateActivity: vi.fn().mockResolvedValue(true),
			updateActivityMeta: vi.fn().mockResolvedValue(undefined),
			removeActivity: vi.fn().mockResolvedValue(undefined),
			generateId: vi.fn().mockReturnValue('generated-id'),
			getContext: vi.fn().mockResolvedValue(undefined),
			saveContext: vi.fn().mockResolvedValue(undefined),
			setup: vi.fn().mockResolvedValue(undefined),
			getStream: vi.fn().mockResolvedValue(undefined),
			getStreamCount: vi.fn().mockResolvedValue(0),
			deliveryEnqueue: vi.fn().mockResolvedValue(true),
			deliveryRequeue: vi.fn().mockResolvedValue(true),
			findActivityByCollectionAndObjectId: vi.fn().mockResolvedValue(undefined),
			findActivityByCollectionAndActorId: vi.fn().mockResolvedValue(undefined),
		}) as IApexStore;

	const createApex = (store: IApexStore) =>
		ActivitypubExpress({
			name: 'test-apex',
			version: '1.0.0',
			domain: DOMAIN,
			actorParam: 'actor',
			objectParam: 'id',
			activityParam: 'id',
			routes: {
				actor: '/u/:actor',
				object: '/o/:id',
				activity: '/s/:id',
				inbox: '/u/:actor/inbox',
				outbox: '/u/:actor/outbox',
				followers: '/u/:actor/followers',
				following: '/u/:actor/following',
				liked: '/u/:actor/liked',
				collections: '/u/:actor/c/:id',
				blocked: '/u/:actor/blocked',
				rejections: '/u/:actor/rejections',
				rejected: '/u/:actor/rejected',
				shares: '/s/:id/shares',
				likes: '/s/:id/likes',
			},
			store,
		});

	describe('resolveUnknown', () => {
		test('does not call saveObject when given an inline object with a local IRI that exists in DB', async () => {
			const store = createMockStore();
			const storedNote = { id: LOCAL_NOTE_ID, type: 'Note', content: 'stored' };
			vi.mocked(store.getObject).mockResolvedValue(storedNote);

			const apex = createApex(store);
			const inlineNote = { id: LOCAL_NOTE_ID, type: 'Note', content: 'incoming' };

			const result = await apex.resolveUnknown(inlineNote);

			expect(result).toEqual(storedNote);
			expect(store.saveObject).not.toHaveBeenCalled();
			expect(store.saveActivity).not.toHaveBeenCalled();
		});

		test('does not call saveObject when given an inline object with a local IRI that does not exist in DB', async () => {
			const store = createMockStore();
			vi.mocked(store.getObject).mockResolvedValue(undefined);
			vi.mocked(store.getActivity).mockResolvedValue(undefined);

			const apex = createApex(store);
			const inlineNote = { id: LOCAL_NOTE_ID, type: 'Note', content: 'incoming' };

			const result = await apex.resolveUnknown(inlineNote);

			expect(result).toEqual(inlineNote);
			expect(store.saveObject).not.toHaveBeenCalled();
			expect(store.saveActivity).not.toHaveBeenCalled();
		});

		test('does not call saveObject when given an inline object that is already cached', async () => {
			const store = createMockStore();
			const cachedRemote = { id: REMOTE_NOTE_ID, type: 'Note', content: 'cached' };
			vi.mocked(store.getObject).mockResolvedValue(cachedRemote);

			const apex = createApex(store);
			const inlineRemote = { id: REMOTE_NOTE_ID, type: 'Note', content: 'fresh' };

			const result = await apex.resolveUnknown(inlineRemote);

			expect(result).toEqual(cachedRemote);
			expect(store.saveObject).not.toHaveBeenCalled();
		});

		test('calls saveObject when given a new remote inline object not in cache', async () => {
			const store = createMockStore();
			vi.mocked(store.getObject).mockResolvedValue(undefined);
			vi.mocked(store.getActivity).mockResolvedValue(undefined);

			const apex = createApex(store);
			const inlineRemote = { id: REMOTE_NOTE_ID, type: 'Note', content: 'fresh' };

			const result = await apex.resolveUnknown(inlineRemote);

			expect(result).toEqual(inlineRemote);
			expect(store.saveObject).toHaveBeenCalledWith(inlineRemote);
		});
	});

	describe('resolveObject', () => {
		test('returns cached local object and does not saveObject when local object exists', async () => {
			const store = createMockStore();
			const storedNote = { id: LOCAL_NOTE_ID, type: 'Note', content: 'stored' };
			vi.mocked(store.getObject).mockResolvedValue(storedNote);

			const apex = createApex(store);
			const inlineNote = { id: LOCAL_NOTE_ID, type: 'Note', content: 'incoming' };

			const result = await apex.resolveObject(inlineNote);

			expect(result).toEqual(storedNote);
			expect(store.saveObject).not.toHaveBeenCalled();
			expect(store.updateObject).not.toHaveBeenCalled();
		});

		test('saves object when local object does not exist yet (e.g. Create activity)', async () => {
			const store = createMockStore();
			vi.mocked(store.getObject).mockResolvedValue(undefined);
			vi.mocked(store.getActivity).mockResolvedValue(undefined);

			const apex = createApex(store);
			const newNote = { id: LOCAL_NOTE_ID, type: 'Note', content: 'newly created' };

			const result = await apex.resolveObject(newNote);

			expect(result).toEqual(newNote);
			expect(store.saveObject).toHaveBeenCalledWith(newNote);
		});

		// 署名検証の鍵リフレッシュは resolveObject(keyId, false, true) を呼ぶ。keyId に自サーバーの
		// アクターを指定されても HTTP で取り直して上書きしてはならない (Issue #150、ADR-0059)。
		test('does not refetch a cached local object by IRI even when refresh is requested', async () => {
			const store = createMockStore();
			const LOCAL_ACTOR_ID = `https://${DOMAIN}/u/alice`;
			const storedActor = { id: LOCAL_ACTOR_ID, type: 'Person', _meta: { privateKey: 'secret' } };
			vi.mocked(store.getObject).mockResolvedValue(storedActor);

			const apex = createApex(store);
			const requestObject = vi.fn().mockResolvedValue({ id: LOCAL_ACTOR_ID, type: 'Person' });
			apex.requestObject = requestObject;

			const result = await apex.resolveObject(`${LOCAL_ACTOR_ID}#main-key`, false, true);

			expect(result).toEqual(storedActor);
			expect(store.getObject).toHaveBeenCalledWith(LOCAL_ACTOR_ID, true);
			expect(requestObject).not.toHaveBeenCalled();
			expect(store.updateObject).not.toHaveBeenCalled();
			expect(store.saveObject).not.toHaveBeenCalled();
		});

		test('still refetches a cached remote object by IRI when refresh is requested', async () => {
			const store = createMockStore();
			vi.mocked(store.getObject).mockResolvedValue({
				id: REMOTE_NOTE_ID,
				type: 'Note',
				content: 'old',
			});

			const apex = createApex(store);
			const fresh = { id: REMOTE_NOTE_ID, type: 'Note', content: 'new' };
			const requestObject = vi.fn().mockResolvedValue(fresh);
			apex.requestObject = requestObject;

			const result = await apex.resolveObject(REMOTE_NOTE_ID, false, true);

			expect(result).toEqual(fresh);
			expect(requestObject).toHaveBeenCalledWith(REMOTE_NOTE_ID);
			expect(store.updateObject).toHaveBeenCalledWith(fresh, null, true);
		});
	});
});
