import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { apex } from '../../src/apex.js';
import { db, escapeFirestoreKey } from '../../src/firebase.js';
import { getFollowers, getFollowersPage } from '../../src/mastodon/presenters/account.js';
import { buildMastodonId } from '../../src/mastodonId.js';
import type { ObjectMeta } from '../../src/meta.js';
import { buildMetaIndex } from '../../src/meta.js';
import { MastodonIds, MastodonIdsByIri, Objects, Streams } from '../../src/schema.js';
import { resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const actor = {
	id: 'https://example.com/activitypub/u/hakatashi',
	type: 'Person',
	preferredUsername: 'hakatashi',
	inbox: 'https://example.com/activitypub/u/hakatashi/inbox',
} as unknown as LocalActor;

// getFollowers は生の object/actor フィールドではなく denormalizations.ts が書き込む
// map 形式の _meta.index を等価条件で引く(→ ADR-0021)。このテストはトリガーが動かない
// Firestore エミュレータのみで実行されるため、トリガーが計算するはずの値をここで
// あらかじめ与えている。
const saveStream = (docId: string, activity: Record<string, unknown> & { _meta?: ObjectMeta }) =>
	Streams.doc(escapeFirestoreKey(docId)).set({
		...activity,
		_meta: { ...activity._meta, index: buildMetaIndex(activity) },
	} as never);

// eslint-disable-next-line max-params
const saveFollow = (docId: string, activityId: string, followerId: string, objectId: string) =>
	saveStream(docId, {
		id: activityId,
		type: 'Follow',
		actor: [followerId],
		object: [objectId],
	});

// Undo の object は、Mastodon のように Follow を丸ごと埋め込んでくる場合と素の IRI 文字列で
// 届く場合がある。どちらも打ち消しとして扱われることを確認するため、object の表現を選べるようにする。
// eslint-disable-next-line max-params
const saveUndoFollow = (
	docId: string,
	activityId: string,
	followerId: string,
	undoneFollow: unknown,
) =>
	saveStream(docId, {
		id: activityId,
		type: 'Undo',
		actor: [followerId],
		object: [undoneFollow],
		_meta: { collection: [actor.inbox as string] },
	});

describe('getFollowers', () => {
	beforeEach(async () => {
		await apex.store.saveObject(actor);
	});

	// Teardown firestore database after each test
	afterEach(async () => {
		await resetFirestore();
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
		expect(followers[0]?.acct).toBe('alice@remote.example');
	});

	test('finds a follower even when the Follow object is an embedded object rather than a bare IRI', async () => {
		// AS2 の object は IRI 文字列だけでなく埋め込みオブジェクトにもなりうる
		// (実際に dev 環境の Undo(Follow) で観測されたケース、Issue #49 のフォローアップ)。
		// _meta.index はどちらの表現からも denormalizations.ts が同じキーに正規化する。
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: 'alice' });
		await saveStream('follow-1', {
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: [{ id: followerId, type: 'Person' }],
			object: [{ id: actor.id, type: 'Person' }],
		});

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0]?.acct).toBe('alice@remote.example');
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
			'https://remote.example/activities/follow-1',
		);

		expect(await getFollowers(actor)).toEqual([]);
	});

	// Mastodon の UndoFollowSerializer は Follow を丸ごと埋め込んでくる (→ ADR-0020)。
	test('excludes a follower whose Undo embeds the Follow activity instead of its IRI', async () => {
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: 'alice' });
		await saveFollow(
			'follow-1',
			'https://remote.example/activities/follow-1',
			followerId,
			actor.id,
		);
		await saveUndoFollow('undo-1', 'https://remote.example/activities/undo-1', followerId, {
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: [followerId],
			object: [actor.id],
		});

		expect(await getFollowers(actor)).toEqual([]);
	});

	test('does not exclude a follower whose Undo targets a different Follow', async () => {
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
			'https://remote.example/activities/follow-somebody-else',
		);

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0]?.acct).toBe('alice@remote.example');
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
			'https://remote.example/activities/follow-1',
		);
		await saveFollow(
			'follow-2',
			'https://remote.example/activities/follow-2',
			followerId,
			actor.id,
		);

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0]?.acct).toBe('alice@remote.example');
	});

	test('handles more than 30 followers by chunking the "in" query', async () => {
		// Firestore の `in` は最大30件までしか指定できないため、31人以上のフォロワーがいても
		// userIdsToAcconts がチャンク分割して結合されることを固定する。
		const followerIds = Array.from(
			{ length: 31 },
			(_, i) => `https://remote.example/u/follower-${i}`,
		);
		const baseTime = Date.parse('2023-01-01T00:00:00.000Z');
		const batch = db.batch();
		for (const [i, followerId] of followerIds.entries()) {
			batch.set(Objects.doc(escapeFirestoreKey(followerId)), {
				id: followerId,
				type: 'Person',
				preferredUsername: `follower-${i}`,
			});
			const activityId = `https://remote.example/activities/follow-chunk-${i}`;
			const activity = {
				id: activityId,
				type: 'Follow',
				actor: [followerId],
				object: [actor.id],
			};
			batch.set(Streams.doc(escapeFirestoreKey(`follow-chunk-${i}`)), {
				...activity,
				_meta: { index: buildMetaIndex(activity) },
			});
			const mastodonId = buildMastodonId(baseTime + i * 1000, 0);
			batch.set(MastodonIds.doc(escapeFirestoreKey(mastodonId)), { iri: activityId });
			batch.set(MastodonIdsByIri.doc(escapeFirestoreKey(activityId)), { mastodonId });
		}
		await batch.commit();

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

	test('paginates followers by the Mastodon ID of the Follow activity', async () => {
		const names = ['a', 'b', 'c', 'd'];
		for (const [i, name] of names.entries()) {
			const followerId = `https://remote.example/u/${name}`;
			await apex.store.saveObject({ id: followerId, type: 'Person', preferredUsername: name });
			await saveStream(`follow-${name}`, {
				id: `https://remote.example/activities/follow-${name}`,
				type: 'Follow',
				actor: [followerId],
				object: [actor.id],
				published: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
			});
		}
		const usernames = (page: { accounts: { username: string }[] }) =>
			page.accounts.map((a) => a.username);

		const first = await getFollowersPage(actor, { limit: 2 });
		expect(usernames(first)).toEqual(['d', 'c']);
		const second = await getFollowersPage(actor, { limit: 2, maxId: first.cursorIds.at(-1) });
		expect(usernames(second)).toEqual(['b', 'a']);
		const none = await getFollowersPage(actor, { limit: 2, maxId: second.cursorIds.at(-1) });
		expect(none.accounts).toEqual([]);
		const forward = await getFollowersPage(actor, { limit: 2, minId: second.cursorIds.at(-1) });
		expect(usernames(forward)).toEqual(['c', 'b']);
	});
});
