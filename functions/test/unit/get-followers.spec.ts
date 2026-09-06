import type { APActor } from 'activitypub-types';
import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { apex } from '../../src/activitypub.js';
import { db } from '../../src/firebase.js';
import { getFollowers } from '../../src/mastodon/api.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const actor = {
	id: 'https://example.com/activitypub/u/hakatashi',
	type: 'Person',
	preferredUsername: 'hakatashi',
	inbox: 'https://example.com/activitypub/u/hakatashi/inbox',
} as unknown as APActor;

// getFollowers は生の object/actor フィールドではなく denormalizations.ts が書き込む
// _meta.objectIds/_meta.actorIds を見る(→ ADR-0020)。このテストはトリガーが動かない
// Firestore エミュレータのみで実行されるため、トリガーが計算するはずの値をここで
// あらかじめ与えている。
// eslint-disable-next-line max-params
const saveFollow = (docId: string, activityId: string, followerId: string, objectId: string) =>
	db
		.collection('streams')
		.doc(docId)
		.set({
			id: activityId,
			type: 'Follow',
			actor: [followerId],
			object: [objectId],
			_meta: { actorIds: [followerId], objectIds: [objectId] },
		});

// eslint-disable-next-line max-params
const saveUndoFollow = (
	docId: string,
	activityId: string,
	followerId: string,
	collection: string,
) =>
	db
		.collection('streams')
		.doc(docId)
		.set({
			id: activityId,
			type: 'Undo',
			actor: [followerId],
			_meta: { collection: [collection], objectType: 'Follow', actorIds: [followerId] },
		});

describe('getFollowers', () => {
	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		await apex.store.saveObject(actor);
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

	test('returns an empty array when nobody has followed the actor', async () => {
		expect(await getFollowers(actor)).toEqual([]);
	});

	test('counts a follower with a single Follow activity', async () => {
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: 'alice' });
		await saveFollow(
			'follow-1',
			'https://remote.example/activities/follow-1',
			followerId,
			actor.id,
		);

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0].acct).toBe('alice@remote.example');
	});

	test('finds a follower even when the Follow object is an embedded object rather than a bare IRI', async () => {
		// AS2 の object は IRI 文字列だけでなく埋め込みオブジェクトにもなりうる
		// (実際に dev 環境の Undo(Follow) で観測されたケース、Issue #49 のフォローアップ)。
		// _meta.objectIds はどちらの表現からも denormalizations.ts が同じ値に正規化する。
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: 'alice' });
		await db
			.collection('streams')
			.doc('follow-1')
			.set({
				id: 'https://remote.example/activities/follow-1',
				type: 'Follow',
				actor: [{ id: followerId, type: 'Person' }],
				object: [{ id: actor.id, type: 'Person' }],
				_meta: { actorIds: [followerId], objectIds: [actor.id] },
			});

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0].acct).toBe('alice@remote.example');
	});

	test('excludes a follower whose Follow was later undone', async () => {
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: 'alice' });
		await saveFollow(
			'follow-1',
			'https://remote.example/activities/follow-1',
			followerId,
			actor.id,
		);
		await saveUndoFollow(
			'undo-1',
			'https://remote.example/activities/undo-1',
			followerId,
			actor.inbox,
		);

		expect(await getFollowers(actor)).toEqual([]);
	});

	test('keeps a follower who unfollowed and followed again', async () => {
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: 'alice' });
		await saveFollow(
			'follow-1',
			'https://remote.example/activities/follow-1',
			followerId,
			actor.id,
		);
		await saveUndoFollow(
			'undo-1',
			'https://remote.example/activities/undo-1',
			followerId,
			actor.inbox,
		);
		await saveFollow(
			'follow-2',
			'https://remote.example/activities/follow-2',
			followerId,
			actor.id,
		);

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0].acct).toBe('alice@remote.example');
	});

	test('handles more than 30 followers by chunking the "in" query', async () => {
		// Firestore の `in` は最大30件までしか指定できないため、31人以上のフォロワーがいても
		// userIdsToAcconts がチャンク分割して結合されることを固定する。
		const followerIds = Array.from(
			{ length: 31 },
			(_, i) => `https://remote.example/u/follower-${i}`,
		);
		await Promise.all(
			followerIds.map((followerId, i) =>
				apex.store.saveObject({
					id: followerId,
					type: 'Person',
					preferredUsername: `follower-${i}`,
				}),
			),
		);
		await Promise.all(
			followerIds.map((followerId, i) =>
				saveFollow(
					`follow-chunk-${i}`,
					`https://remote.example/activities/follow-chunk-${i}`,
					followerId,
					actor.id,
				),
			),
		);

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(31);
		expect(new Set(followers.map((follower) => follower.acct)).size).toBe(31);
	});

	test('does not count a Follow directed at a different actor', async () => {
		const followerId = 'https://remote.example/u/alice';
		const otherActorId = 'https://example.com/activitypub/u/someoneelse';
		await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: 'alice' });
		await saveFollow(
			'follow-1',
			'https://remote.example/activities/follow-1',
			followerId,
			otherActorId,
		);

		expect(await getFollowers(actor)).toEqual([]);
	});
});
