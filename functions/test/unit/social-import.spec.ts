import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { LOCAL_USERNAME } from '../../src/localActor.js';
import { Bookmarks, FollowRelations, Streams } from '../../src/schema.js';
import {
	importBookmarks,
	importFollowing,
	importLists,
	parseBookmarksCsv,
	parseFollowingCsv,
	parseListsCsv,
} from '../../src/social/import.js';
import { getLists } from '../../src/social/lists.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

describe('social/import (ADR-0124)', () => {
	let me: LocalActor;

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		me = await createLocalActor(LOCAL_USERNAME);
	});

	afterEach(async () => {
		await resetFirestore();
	});

	describe('parseFollowingCsv', () => {
		test('parses accounts from Mastodon following_accounts.csv format', () => {
			const csv = `Account address,Show boosts,Notify on new posts,Languages
alice@remote.example,true,false,
"bob@remote.example",false,true,en
@carol@other.example,true,false,
invalid-format,true,false,

dave@third.example,true,false,
alice@remote.example,true,false,
`;
			const result = parseFollowingCsv(csv);
			expect(result).toEqual([
				'alice@remote.example',
				'bob@remote.example',
				'carol@other.example',
				'dave@third.example',
			]);
		});
	});

	describe('parseBookmarksCsv', () => {
		test('parses status URLs from Mastodon bookmarks.csv format', () => {
			const csv = `https://pawoo.net/users/user1/statuses/100
https://pawoo.net/users/user2/statuses/200

not-a-url
https://pawoo.net/users/user1/statuses/100
`;
			const result = parseBookmarksCsv(csv);
			expect(result).toEqual([
				'https://pawoo.net/users/user1/statuses/100',
				'https://pawoo.net/users/user2/statuses/200',
			]);
		});
	});

	describe('importFollowing', () => {
		const ALICE_ID = 'https://remote.example/users/alice';
		const BOB_ID = 'https://remote.example/users/bob';
		const CAROL_ID = 'https://remote.example/users/carol';
		const MOVED_ID = 'https://remote.example/users/moved';
		const NEW_MOVED_ID = 'https://new.example/users/moved_new';

		beforeEach(async () => {
			await apex.store.saveObject({
				id: ALICE_ID,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${ALICE_ID}/inbox`,
				outbox: `${ALICE_ID}/outbox`,
				_meta: { preferredUsername: 'alice' },
			} as never);

			await apex.store.saveObject({
				id: BOB_ID,
				type: 'Person',
				preferredUsername: 'bob',
				inbox: `${BOB_ID}/inbox`,
				outbox: `${BOB_ID}/outbox`,
				_meta: { preferredUsername: 'bob' },
			} as never);

			await apex.store.saveObject({
				id: CAROL_ID,
				type: 'Person',
				preferredUsername: 'carol',
				inbox: `${CAROL_ID}/inbox`,
				outbox: `${CAROL_ID}/outbox`,
				_meta: { preferredUsername: 'carol' },
			} as never);

			await apex.store.saveObject({
				id: MOVED_ID,
				type: 'Person',
				preferredUsername: 'moved',
				inbox: `${MOVED_ID}/inbox`,
				outbox: `${MOVED_ID}/outbox`,
				movedTo: NEW_MOVED_ID,
				_meta: { preferredUsername: 'moved' },
			} as never);
		});

		test('follows un-followed accounts when dryRun is false', async () => {
			const result = await importFollowing(me, ['alice@remote.example'], {
				dryRun: false,
				intervalMs: 0,
			});

			expect(result.total).toBe(1);
			expect(result.followed).toEqual(['alice@remote.example']);
			expect(result.alreadyFollowing).toEqual([]);
			expect(result.failed).toEqual([]);

			// Streams に Follow activity が作成されたこと
			const streams = await Streams.where('type', '==', 'Follow')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(streams.docs).toHaveLength(1);
			expect(streams.docs[0]?.data().object).toEqual([ALICE_ID]);
		});

		test('does not send Follow when dryRun is true', async () => {
			const result = await importFollowing(me, ['alice@remote.example'], {
				dryRun: true,
				intervalMs: 0,
			});

			expect(result.total).toBe(1);
			expect(result.followed).toEqual(['alice@remote.example']);

			const streams = await Streams.where('type', '==', 'Follow')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(streams.docs).toHaveLength(0);
		});

		test('idempotency: skips already followed and pending approval accounts', async () => {
			// alice を accepted (フォロー済み) にする
			await FollowRelations(escapeFirestoreKey(me.id), 'following')
				.doc(escapeFirestoreKey(ALICE_ID))
				.set({
					actor: ALICE_ID,
					followIri: `${ALICE_ID}#follow`,
					followMastodonId: '100',
					state: 'accepted',
					createdAt: new Date() as never,
					follows: [],
				});

			// bob を pending (承認待ち) にする
			await FollowRelations(escapeFirestoreKey(me.id), 'following')
				.doc(escapeFirestoreKey(BOB_ID))
				.set({
					actor: BOB_ID,
					followIri: `${BOB_ID}#follow`,
					followMastodonId: '200',
					state: 'pending',
					createdAt: new Date() as never,
					follows: [],
				});

			const result = await importFollowing(
				me,
				['alice@remote.example', 'bob@remote.example', 'carol@remote.example'],
				{ dryRun: false, intervalMs: 0 },
			);

			expect(result.alreadyFollowing).toEqual(['alice@remote.example']);
			expect(result.pendingApproval).toEqual(['bob@remote.example']);
			expect(result.followed).toEqual(['carol@remote.example']);

			// carol のみ Follow が作成されること
			const streams = await Streams.where('type', '==', 'Follow')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(streams.docs).toHaveLength(1);
			expect(streams.docs[0]?.data().object).toEqual([CAROL_ID]);

			// もう一度実行しても carol も二重にフォローされないこと (再実行の冪等性)
			const secondResult = await importFollowing(
				me,
				['alice@remote.example', 'bob@remote.example', 'carol@remote.example'],
				{ dryRun: false, intervalMs: 0 },
			);
			expect(secondResult.followed).toEqual([]);
			expect(secondResult.pendingApproval).toEqual(['bob@remote.example', 'carol@remote.example']);
		});

		test('skips moved accounts and records them in result.moved', async () => {
			const result = await importFollowing(me, ['moved@remote.example'], {
				dryRun: false,
				intervalMs: 0,
			});

			expect(result.moved).toEqual([{ acct: 'moved@remote.example', movedTo: NEW_MOVED_ID }]);
			expect(result.followed).toEqual([]);

			const streams = await Streams.where('type', '==', 'Follow').get();
			expect(streams.docs).toHaveLength(0);
		});

		test('skips unresolvable accounts and records them in result.failed', async () => {
			const result = await importFollowing(me, ['unknown@nonexistent.example'], {
				dryRun: false,
				intervalMs: 0,
			});

			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]?.acct).toBe('unknown@nonexistent.example');
			expect(result.followed).toEqual([]);
		});

		test('skips self account', async () => {
			const selfAcct = `${LOCAL_USERNAME}@activitypub-dev.hakatashi.com`;
			const result = await importFollowing(me, [selfAcct], {
				dryRun: false,
				intervalMs: 0,
			});

			expect(result.skippedSelf).toEqual([selfAcct]);
			expect(result.followed).toEqual([]);
		});
	});

	describe('importBookmarks', () => {
		const STATUS_URL = 'https://remote.example/users/alice/statuses/123';
		const ALICE_ID = 'https://remote.example/users/alice';

		beforeEach(async () => {
			await apex.store.saveObject({
				id: ALICE_ID,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${ALICE_ID}/inbox`,
				outbox: `${ALICE_ID}/outbox`,
				_meta: { preferredUsername: 'alice' },
			} as never);

			await apex.store.saveObject({
				id: STATUS_URL,
				type: 'Note',
				attributedTo: [ALICE_ID],
				content: 'test bookmark',
				published: '2026-01-01T00:00:00.000Z',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				cc: [],
			} as never);
		});

		test('bookmarks status when dryRun is false', async () => {
			const result = await importBookmarks(me, [STATUS_URL], {
				dryRun: false,
				intervalMs: 0,
			});

			expect(result.total).toBe(1);
			expect(result.bookmarked).toEqual([STATUS_URL]);
			expect(result.alreadyBookmarked).toEqual([]);

			const bookmark = await Bookmarks(escapeFirestoreKey(me.id))
				.doc(escapeFirestoreKey(STATUS_URL))
				.get();
			expect(bookmark.exists).toBe(true);
			expect(bookmark.data()?.noteIri).toBe(STATUS_URL);
		});

		test('does not save bookmark when dryRun is true', async () => {
			const result = await importBookmarks(me, [STATUS_URL], {
				dryRun: true,
				intervalMs: 0,
			});

			expect(result.bookmarked).toEqual([STATUS_URL]);

			const bookmark = await Bookmarks(escapeFirestoreKey(me.id))
				.doc(escapeFirestoreKey(STATUS_URL))
				.get();
			expect(bookmark.exists).toBe(false);
		});

		test('idempotency: skips already bookmarked statuses', async () => {
			// 初回インポート
			await importBookmarks(me, [STATUS_URL], { dryRun: false, intervalMs: 0 });

			// 2回目インポート
			const result = await importBookmarks(me, [STATUS_URL], { dryRun: false, intervalMs: 0 });
			expect(result.bookmarked).toEqual([]);
			expect(result.alreadyBookmarked).toEqual([STATUS_URL]);
		});

		test('skips unresolvable statuses and records them in result.failed', async () => {
			const unknownUrl = 'https://remote.example/users/alice/statuses/999';
			const result = await importBookmarks(me, [unknownUrl], {
				dryRun: false,
				intervalMs: 0,
			});

			expect(result.failed).toHaveLength(1);
			expect(result.failed[0]?.url).toBe(unknownUrl);
			expect(result.bookmarked).toEqual([]);
		});
	});

	describe('parseListsCsv', () => {
		test('parses list names and accounts from Mastodon lists.csv format', () => {
			const csv = `TSG,hakatashi@pawoo.net
TSG,azaika@pawoo.net
"Friends, close",@bob@remote.example
"He said ""hi""",carol@other.example

TSG,invalid-format
,dave@third.example
TSG,azaika@pawoo.net
TSG,AZAIKA@pawoo.net
`;
			expect(parseListsCsv(csv)).toEqual([
				{ listName: 'TSG', acct: 'hakatashi@pawoo.net' },
				{ listName: 'TSG', acct: 'azaika@pawoo.net' },
				{ listName: 'Friends, close', acct: 'bob@remote.example' },
				{ listName: 'He said "hi"', acct: 'carol@other.example' },
			]);
		});
	});

	describe('importLists', () => {
		const ALICE_ID = 'https://remote.example/users/alice';
		const BOB_ID = 'https://remote.example/users/bob';
		const MOVED_ID = 'https://remote.example/users/moved';

		beforeEach(async () => {
			for (const [id, name, extra] of [
				[ALICE_ID, 'alice', {}],
				[BOB_ID, 'bob', {}],
				[MOVED_ID, 'moved', { movedTo: 'https://new.example/users/moved' }],
			] as const) {
				await apex.store.saveObject({
					id,
					type: 'Person',
					preferredUsername: name,
					inbox: `${id}/inbox`,
					outbox: `${id}/outbox`,
					_meta: { preferredUsername: name },
					...extra,
				} as never);
			}
			// alice はフォロー済み
			await FollowRelations(escapeFirestoreKey(me.id), 'following')
				.doc(escapeFirestoreKey(ALICE_ID))
				.set({
					actor: ALICE_ID,
					followIri: `${ALICE_ID}#follow`,
					followMastodonId: '100',
					state: 'accepted',
					createdAt: new Date() as never,
					follows: [],
				});
		});

		const selfAcct = () => `${LOCAL_USERNAME}@${new URL(me.id).host}`;

		test('creates lists, follows unfollowed accounts and adds members', async () => {
			const rows = [
				{ listName: 'TSG', acct: 'alice@remote.example' },
				{ listName: 'TSG', acct: 'bob@remote.example' },
				{ listName: 'TSG', acct: selfAcct() },
				{ listName: 'TSG', acct: 'moved@remote.example' },
				{ listName: 'Other', acct: 'alice@remote.example' },
				{ listName: 'TSG', acct: 'nobody@unresolvable.invalid' },
			];
			const result = await importLists(me, rows, { intervalMs: 0 });

			expect(result.createdLists).toEqual(['TSG', 'Other']);
			expect(result.added.map((row) => row.acct)).toEqual([
				'alice@remote.example',
				selfAcct(),
				'alice@remote.example',
			]);
			expect(result.followedAndAdded.map((row) => row.acct)).toEqual(['bob@remote.example']);
			expect(result.moved.map((row) => row.acct)).toEqual(['moved@remote.example']);
			expect(result.failed.map((row) => row.acct)).toEqual(['nobody@unresolvable.invalid']);

			const lists = await getLists(me.id);
			expect(lists.map((list) => [list.title, list.accounts])).toEqual([
				['TSG', [ALICE_ID, BOB_ID, me.id]],
				['Other', [ALICE_ID]],
			]);

			// bob にだけ Follow を送る
			const follows = await Streams.where('type', '==', 'Follow')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(follows.docs.map((doc) => doc.data().object)).toEqual([[BOB_ID]]);

			// 再実行しても重複して足さず、リストも作り直さない
			const second = await importLists(me, rows, { intervalMs: 0 });
			expect(second.createdLists).toEqual([]);
			expect(second.alreadyMember).toHaveLength(4);
			expect(second.added).toEqual([]);
			expect(second.followedAndAdded).toEqual([]);
			expect(await getLists(me.id)).toHaveLength(2);
		});

		test('skips unfollowed accounts when follow is false', async () => {
			const result = await importLists(
				me,
				[
					{ listName: 'TSG', acct: 'alice@remote.example' },
					{ listName: 'TSG', acct: 'bob@remote.example' },
				],
				{ intervalMs: 0, follow: false },
			);
			expect(result.added.map((row) => row.acct)).toEqual(['alice@remote.example']);
			expect(result.notFollowing.map((row) => row.acct)).toEqual(['bob@remote.example']);
			const [list] = await getLists(me.id);
			expect(list?.accounts).toEqual([ALICE_ID]);
		});

		test('does not write anything when dryRun is true', async () => {
			const result = await importLists(
				me,
				[
					{ listName: 'TSG', acct: 'alice@remote.example' },
					{ listName: 'TSG', acct: 'bob@remote.example' },
				],
				{ intervalMs: 0, dryRun: true },
			);
			expect(result.createdLists).toEqual(['TSG']);
			expect(result.added.map((row) => row.acct)).toEqual(['alice@remote.example']);
			expect(result.followedAndAdded.map((row) => row.acct)).toEqual(['bob@remote.example']);
			expect(await getLists(me.id)).toEqual([]);
			const follows = await Streams.where('type', '==', 'Follow')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(follows.empty).toBe(true);
		});
	});
});
