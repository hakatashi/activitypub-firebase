import { describe, expect, test, afterEach, beforeEach } from 'vitest';
import { apex } from '../../src/apex.js';
import { db, escapeFirestoreKey } from '../../src/firebase.js';
import {
	getFollowers,
	getFollowersPage,
	getFollowingPage,
} from '../../src/mastodon/presenters/account.js';
import { buildMastodonId } from '../../src/mastodonId.js';
import { FollowRelations, Objects } from '../../src/schema.js';
import type { FollowRelationSide, FollowState } from '../../src/schema.js';
import { resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const actor = {
	id: 'https://example.com/activitypub/u/hakatashi',
	type: 'Person',
	preferredUsername: 'hakatashi',
	inbox: 'https://example.com/activitypub/u/hakatashi/inbox',
} as unknown as LocalActor;

const baseTime = Date.parse('2026-01-01T00:00:00.000Z');

// フォロー一覧は射影 (→ ADR-0082, ADR-0083) から読むので、射影と相手の actor を直接書いておく。
// oxlint-disable-next-line max-params
const addRelation = (
	batch: FirebaseFirestore.WriteBatch,
	side: FollowRelationSide,
	name: string,
	index: number,
	state: FollowState = 'accepted',
) => {
	const iri = `https://remote.example/u/${name}`;
	const followIri = `https://remote.example/activities/follow-${name}`;
	const mastodonId = buildMastodonId(baseTime + index * 1000, 0);
	batch.set(Objects.doc(escapeFirestoreKey(iri)), {
		id: iri,
		type: 'Person',
		preferredUsername: name,
	});
	batch.set(FollowRelations(escapeFirestoreKey(actor.id), side).doc(escapeFirestoreKey(iri)), {
		actor: iri,
		followIri,
		followMastodonId: mastodonId,
		state,
		createdAt: new Date() as never,
		follows: [{ iri: followIri, state, mastodonId }],
	});
};

const usernames = (page: { accounts: { username: string }[] }) =>
	page.accounts.map((a) => a.username);

describe('getFollowers / getFollowingPage', () => {
	beforeEach(async () => {
		await apex.store.saveObject(actor);
	});

	afterEach(async () => {
		await resetFirestore();
	});

	test('returns an empty array when nobody has followed the actor', async () => {
		expect(await getFollowers(actor)).toEqual([]);
	});

	test('returns a follower as a Mastodon account', async () => {
		const batch = db.batch();
		addRelation(batch, 'followers', 'alice', 0);
		await batch.commit();

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0]?.acct).toBe('alice@remote.example');
	});

	test('handles more than 30 followers by chunking the "in" query', async () => {
		// Firestore の `in` は最大30件までしか指定できないため、31人以上のフォロワーがいても
		// userIdsToAccounts がチャンク分割して結合されることを固定する。
		const batch = db.batch();
		for (let i = 0; i < 31; i++) {
			addRelation(batch, 'followers', `follower-${i}`, i);
		}
		await batch.commit();

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(31);
		expect(new Set(followers.map((follower) => follower.acct)).size).toBe(31);
	});

	test('paginates followers by the Mastodon ID of the Follow activity', async () => {
		const batch = db.batch();
		for (const [i, name] of ['a', 'b', 'c', 'd'].entries()) {
			addRelation(batch, 'followers', name, i);
		}
		await batch.commit();

		const first = await getFollowersPage(actor, { limit: 2 });
		expect(usernames(first)).toEqual(['d', 'c']);
		const second = await getFollowersPage(actor, { limit: 2, maxId: first.cursorIds.at(-1) });
		expect(usernames(second)).toEqual(['b', 'a']);
		const none = await getFollowersPage(actor, { limit: 2, maxId: second.cursorIds.at(-1) });
		expect(none.accounts).toEqual([]);
		const forward = await getFollowersPage(actor, { limit: 2, minId: second.cursorIds.at(-1) });
		expect(usernames(forward)).toEqual(['c', 'b']);
	});

	test('lists only accepted follows as following', async () => {
		const batch = db.batch();
		addRelation(batch, 'following', 'a', 0);
		addRelation(batch, 'following', 'b', 1, 'pending');
		addRelation(batch, 'following', 'c', 2);
		await batch.commit();

		const page = await getFollowingPage(actor, { limit: 40 });
		expect(usernames(page)).toEqual(['c', 'a']);
		expect(page.cursorIds).toEqual([
			buildMastodonId(baseTime + 2000, 0),
			buildMastodonId(baseTime, 0),
		]);
	});
});
