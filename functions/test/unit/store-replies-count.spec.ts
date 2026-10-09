import { describe, expect, test, afterEach } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { Objects } from '../../src/schema.js';
import Store from '../../src/store/index.js';
import { getCountedReplyTarget } from '../../src/store/replies.js';
import { resetFirestore } from '../helpers/index.js';

// 返信数の非正規化カウンタ `_meta.repliesCount` (→ ADR-0102)。
describe('replies count', () => {
	const store = new Store();
	const author = 'https://example.com/users/alice';
	const parentId = 'https://example.com/notes/parent';
	const publicAddress = 'https://www.w3.org/ns/activitystreams#Public';

	const parent: APObject = {
		id: parentId,
		type: 'Note',
		attributedTo: author,
		to: [publicAddress],
		content: 'parent',
	};

	const reply = (id: string, overrides: Partial<APObject> = {}): APObject => ({
		id,
		type: 'Note',
		attributedTo: 'https://remote.example/users/bob',
		inReplyTo: [parentId],
		to: [publicAddress],
		content: 'reply',
		...overrides,
	});

	const getRepliesCount = async (id = parentId) =>
		(await store.getObject(id, true))?._meta?.repliesCount;

	afterEach(async () => {
		await resetFirestore();
	});

	describe('getCountedReplyTarget', () => {
		test('returns the reply target of a public reply', () => {
			expect(getCountedReplyTarget(reply('https://example.com/notes/r'))).toBe(parentId);
		});

		test('ignores tombstones, direct replies and self replies', () => {
			expect(
				getCountedReplyTarget({ id: 'https://example.com/notes/r', type: 'Tombstone' }),
			).toBeUndefined();
			expect(
				getCountedReplyTarget(reply('https://example.com/notes/r', { to: [author], cc: [] })),
			).toBeUndefined();
			expect(getCountedReplyTarget(reply(parentId, { inReplyTo: parentId }))).toBeUndefined();
		});

		test('counts followers-only replies', () => {
			expect(
				getCountedReplyTarget(
					reply('https://example.com/notes/r', {
						to: ['https://remote.example/users/bob/followers'],
					}),
				),
			).toBe(parentId);
		});
	});

	test('increments the reply target when a reply is saved', async () => {
		await store.saveObject(parent);
		await store.saveObject(reply('https://example.com/notes/r1'));
		await store.saveObject(reply('https://example.com/notes/r2'));
		expect(await getRepliesCount()).toBe(2);
	});

	test('does not count the same reply twice', async () => {
		await store.saveObject(parent);
		await store.saveObject(reply('https://example.com/notes/r1'));
		await store.saveObject(reply('https://example.com/notes/r1', { content: 'edited' }));
		await store.updateObject(reply('https://example.com/notes/r1'), null, true);
		expect(await getRepliesCount()).toBe(1);
	});

	test('does not count direct replies', async () => {
		await store.saveObject(parent);
		await store.saveObject(reply('https://example.com/notes/r1', { to: [author] }));
		expect(await getRepliesCount()).toBeUndefined();
	});

	test('decrements the reply target when a reply becomes a tombstone', async () => {
		await store.saveObject(parent);
		await store.saveObject(reply('https://example.com/notes/r1'));
		await store.saveObject(reply('https://example.com/notes/r2'));
		// Delete で届く Tombstone は inReplyTo を持たない。
		await store.updateObject(
			{ id: 'https://example.com/notes/r1', type: 'Tombstone', deleted: new Date().toISOString() },
			null,
			true,
		);
		expect(await getRepliesCount()).toBe(1);
		// 同じ Tombstone を再度受け取っても減らさない。
		await store.updateObject({ id: 'https://example.com/notes/r1', type: 'Tombstone' }, null, true);
		expect(await getRepliesCount()).toBe(1);
	});

	test('moves the count when the reply target changes on update', async () => {
		const otherId = 'https://example.com/notes/other';
		await store.saveObject(parent);
		await store.saveObject({ ...parent, id: otherId });
		await store.saveObject(reply('https://example.com/notes/r1'));
		await store.updateObject(
			reply('https://example.com/notes/r1', { inReplyTo: [otherId] }),
			null,
			true,
		);
		expect(await getRepliesCount()).toBe(0);
		expect(await getRepliesCount(otherId)).toBe(1);
	});

	test('follows partial updates', async () => {
		await store.saveObject(parent);
		await store.saveObject(reply('https://example.com/notes/r1'));
		await store.updateObject(
			{ id: 'https://example.com/notes/r1', type: 'Note', to: [author] },
			null,
			false,
		);
		expect(await getRepliesCount()).toBe(0);
	});

	test('initializes the count from existing replies when the target is saved later', async () => {
		await store.saveObject(reply('https://example.com/notes/r1'));
		await store.saveObject(reply('https://example.com/notes/r2'));
		await store.saveObject(reply('https://example.com/notes/r3', { to: [author] }));
		expect(await getRepliesCount()).toBeUndefined();
		await store.saveObject(parent);
		expect(await getRepliesCount()).toBe(2);
		// 既存の Note を保存し直しても数え直さない。
		await store.saveObject(parent);
		expect(await getRepliesCount()).toBe(2);
	});

	test('does not decrement below zero', async () => {
		await store.saveObject(parent);
		await store.saveObject(reply('https://example.com/notes/r1'));
		await Objects.doc(escapeFirestoreKey(parentId)).update({ '_meta.repliesCount': 0 });
		await store.updateObject({ id: 'https://example.com/notes/r1', type: 'Tombstone' }, null, true);
		expect(await getRepliesCount()).toBe(0);
	});
});
