import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { localFollowersId } from '../../src/localActor.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { buildMetaIndex } from '../../src/meta.js';
import { followContributions, rebuildFollowProjection } from '../../src/projections/follows.js';
import { FollowRelations, Streams, UserInfos } from '../../src/schema.js';
import type { FollowRelation, FollowRelationSide } from '../../src/schema.js';
import {
	getFollowerActorIris,
	getFollowing,
	getPendingFollowTargetIris,
} from '../../src/social/follows.js';
import { toIdArray } from '../../src/utils.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const ALICE = 'https://remote.example/u/alice';
const BOB = 'https://remote.example/u/bob';
const CAROL = 'https://remote.example/u/carol';

const wrapWithRawBody = (target: unknown) => {
	const wrapper = express();
	wrapper.use(
		express.raw({ type: () => true, limit: '10mb' }),
		(req, res, next) => {
			(req as { rawBody?: unknown }).rawBody = req.body;
			req.body = (req.body as Buffer).toString('utf-8');
			next();
		},
		target as unknown as express.RequestHandler,
	);
	return wrapper;
};

describe('follow projection (Issue #193, ADR-0082)', () => {
	let me: LocalActor;
	let originalEnv: string;
	const mastodonIds = new Map<string, string>();

	const postInbox = async (activity: Record<string, unknown>) => {
		const res = await request(wrapWithRawBody(activitypub))
			.post('/activitypub/u/hakatashi/inbox')
			.set('Content-Type', 'application/activity+json')
			.send(JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', ...activity }));
		expect(res.status).toBe(200);
	};

	const followMe = (id: string, actor: string) =>
		postInbox({ id, type: 'Follow', actor, object: me.id });

	const mastodonFollow = async (target: string, action: 'follow' | 'unfollow' = 'follow') => {
		const res = await request(mastodon)
			.post(`/api/v1/accounts/${mastodonIds.get(target)}/${action}`)
			.set('Authorization', 'Bearer follow-token');
		expect(res.status).toBe(200);
	};

	const outgoingFollowIris = async (target: string) => {
		const docs = await Streams.where('type', '==', 'Follow').get();
		return docs.docs
			.map((doc) => doc.data())
			.filter((follow) => toIdArray(follow.object).includes(target))
			.map((follow) => follow.id);
	};

	const getRelations = async (side: FollowRelationSide) => {
		const docs = await FollowRelations(escapeFirestoreKey(me.id), side).get();
		return new Map<string, FollowRelation>(docs.docs.map((doc) => [doc.data().actor, doc.data()]));
	};

	const getCounts = async () => {
		const userInfo = (await UserInfos.doc(escapeFirestoreKey(me.id)).get()).data();
		return { followers: userInfo?.followers_count, following: userInfo?.following_count };
	};

	// removeSupersededFollows は onStreamWritten が書く `_meta.index` を引くので、トリガーの代わりに書いておく。
	const reindexStreams = async () => {
		const docs = await Streams.get();
		await Promise.all(
			docs.docs.map((doc) => doc.ref.update({ '_meta.index': buildMetaIndex(doc.data()) })),
		);
	};

	// apex の AP コレクション (`_meta.collection` から作られる) の中身を IRI の集合で返す。
	// `totalItems` はページを指定しないコレクションの説明だけに載る (apex の JSON-LD 形式で配列になる)。
	const apCollection = async (side: FollowRelationSide) => {
		const get = (page?: number) =>
			side === 'followers' ? apex.getFollowers(me, page, true) : apex.getFollowing(me, page, true);
		const [description, all] = await Promise.all([get(), get(Infinity)]);
		const items = toIdArray(all.orderedItems);
		expect([description.totalItems].flat()).toEqual([items.length]);
		return new Set(items);
	};

	// 射影・読み取り関数・カウンタ・AP の followers / following コレクションが食い違わないことを確かめる
	// (→ ADR-0082, ADR-0083)。
	const expectConsistent = async () => {
		const [followers, following, followerIris, followingIris, pendingIris, counts] =
			await Promise.all([
				getRelations('followers'),
				getRelations('following'),
				getFollowerActorIris(me),
				getFollowing(me),
				getPendingFollowTargetIris(me),
				getCounts(),
			]);
		const accepted = [...following.values()].filter(({ state }) => state === 'accepted');
		const pending = [...following.values()].filter(({ state }) => state === 'pending');
		expect(new Set(followerIris)).toEqual(new Set(followers.keys()));
		expect(new Set(followingIris)).toEqual(new Set(accepted.map(({ actor }) => actor)));
		expect(pendingIris).toEqual(new Set(pending.map(({ actor }) => actor)));
		expect(counts).toEqual({ followers: followers.size, following: accepted.length });
		expect(await apCollection('followers')).toEqual(new Set(followers.keys()));
		expect(await apCollection('following')).toEqual(new Set(accepted.map(({ actor }) => actor)));
	};

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);
		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
		await addAccessToken('follow-token', 'write:follows', UID_ME);
		for (const [iri, name] of [
			[ALICE, 'alice'],
			[BOB, 'bob'],
			[CAROL, 'carol'],
		] as const) {
			await apex.store.saveObject({
				id: iri,
				type: 'Person',
				preferredUsername: name,
				inbox: `${iri}/inbox`,
				outbox: `${iri}/outbox`,
			});
			mastodonIds.set(iri, await getOrAssignMastodonId(iri, undefined));
		}
		originalEnv = app.get('env') as string;
		app.set('env', 'development');
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		app.set('env', originalEnv);
		await resetFirestore();
	});

	describe('followers', () => {
		test('adds a follower when a Follow is received and auto-accepted', async () => {
			await followMe('https://remote.example/follows/alice-1', ALICE);

			const followers = await getRelations('followers');
			expect([...followers.keys()]).toEqual([ALICE]);
			expect(followers.get(ALICE)).toMatchObject({
				actor: ALICE,
				followIri: 'https://remote.example/follows/alice-1',
				state: 'accepted',
			});
			expect(followers.get(ALICE)?.followMastodonId).toMatch(/^\d{20}$/);
			expect(await getCounts()).toEqual({ followers: 1, following: 0 });
			await expectConsistent();
		});

		test('ignores redelivery of the same Follow', async () => {
			await followMe('https://remote.example/follows/alice-1', ALICE);
			await followMe('https://remote.example/follows/alice-1', ALICE);

			expect((await getRelations('followers')).size).toBe(1);
			expect(await getCounts()).toEqual({ followers: 1, following: 0 });
			await expectConsistent();
		});

		test('replaces a superseded Follow from the same actor without double counting', async () => {
			await followMe('https://remote.example/follows/alice-1', ALICE);
			// removeSupersededFollows は onStreamWritten が書く `_meta.index` で古い Follow を探す
			await reindexStreams();
			await followMe('https://remote.example/follows/alice-2', ALICE);
			await followMe('https://remote.example/follows/bob-1', BOB);

			const followers = await getRelations('followers');
			expect(followers.size).toBe(2);
			expect(followers.get(ALICE)?.followIri).toBe('https://remote.example/follows/alice-2');
			expect(followers.get(ALICE)?.follows).toHaveLength(1);
			expect(await getCounts()).toEqual({ followers: 2, following: 0 });
			await expectConsistent();
		});

		test('removes a follower on Undo(Follow), and a repeated Undo is a no-op', async () => {
			await followMe('https://remote.example/follows/alice-1', ALICE);
			await followMe('https://remote.example/follows/bob-1', BOB);
			const undo = {
				id: 'https://remote.example/undos/alice-1',
				type: 'Undo',
				actor: ALICE,
				object: 'https://remote.example/follows/alice-1',
			};
			await postInbox(undo);
			await postInbox({ ...undo, id: 'https://remote.example/undos/alice-1-again' });

			expect([...(await getRelations('followers')).keys()]).toEqual([BOB]);
			expect(await getCounts()).toEqual({ followers: 1, following: 0 });
			await expectConsistent();
		});

		test('removes a follower when the local actor rejects it (outbox Reject)', async () => {
			await followMe('https://remote.example/follows/alice-1', ALICE);
			const follow = await apex.store.getActivity('https://remote.example/follows/alice-1', true);
			expect(follow).toBeDefined();
			// apex の outbox reject と同じ Store 呼び出し (activity.ts の outboxSideEffects)
			await apex.store.updateActivityMeta(follow as APObject, 'collection', localFollowersId, true);

			expect((await getRelations('followers')).size).toBe(0);
			expect(await getCounts()).toEqual({ followers: 0, following: 0 });
			await expectConsistent();
		});
	});

	describe('following', () => {
		const acceptFrom = (actor: string, followIri: string) =>
			postInbox({ id: `${followIri}#accept`, type: 'Accept', actor, object: followIri });

		test('adds a pending entry on follow and accepts it on Accept', async () => {
			await mastodonFollow(BOB);

			let following = await getRelations('following');
			expect(following.get(BOB)).toMatchObject({ actor: BOB, state: 'pending' });
			expect(await getCounts()).toEqual({ followers: 0, following: 0 });
			await expectConsistent();

			const [followIri] = await outgoingFollowIris(BOB);
			expect(followIri).toBeDefined();
			await acceptFrom(BOB, followIri as string);
			// 再送された Accept はカウンタを動かさない
			await acceptFrom(BOB, followIri as string);

			following = await getRelations('following');
			expect(following.get(BOB)).toMatchObject({ state: 'accepted', followIri });
			expect(await getCounts()).toEqual({ followers: 0, following: 1 });
			await expectConsistent();
		});

		test('removes the entry on unfollow', async () => {
			await mastodonFollow(BOB);
			await mastodonFollow(CAROL);
			const [followIri] = await outgoingFollowIris(BOB);
			await acceptFrom(BOB, followIri as string);
			await mastodonFollow(BOB, 'unfollow');
			await mastodonFollow(CAROL, 'unfollow');

			expect((await getRelations('following')).size).toBe(0);
			expect(await getCounts()).toEqual({ followers: 0, following: 0 });
			await expectConsistent();
		});

		test('keeps the remaining pending Follow when one of duplicate Follows is undone', async () => {
			// 承認前にもう一度 follow すると、同じ相手への Follow が 2 件になる
			await mastodonFollow(BOB);
			await mastodonFollow(BOB);
			const followIris = await outgoingFollowIris(BOB);
			expect(followIris).toHaveLength(2);
			expect((await getRelations('following')).get(BOB)?.follows).toHaveLength(2);

			await acceptFrom(BOB, followIris[0] as string);
			expect((await getRelations('following')).get(BOB)).toMatchObject({
				state: 'accepted',
				followIri: followIris[0],
			});
			expect(await getCounts()).toEqual({ followers: 0, following: 1 });
			await expectConsistent();

			// unfollow は承認済みの Follow を Undo する。もう一方は承認待ちとして残る。
			await mastodonFollow(BOB, 'unfollow');
			expect((await getRelations('following')).get(BOB)).toMatchObject({
				state: 'pending',
				followIri: followIris[1],
			});
			expect(await getCounts()).toEqual({ followers: 0, following: 0 });
			await expectConsistent();
		});

		test('removes the entry when the remote rejects a pending or accepted Follow', async () => {
			await mastodonFollow(BOB);
			await mastodonFollow(CAROL);
			const [bobFollow] = await outgoingFollowIris(BOB);
			const [carolFollow] = await outgoingFollowIris(CAROL);
			await acceptFrom(CAROL, carolFollow as string);
			expect(await getCounts()).toEqual({ followers: 0, following: 1 });

			await postInbox({ id: `${bobFollow}#reject`, type: 'Reject', actor: BOB, object: bobFollow });
			await postInbox({
				id: `${carolFollow}#reject`,
				type: 'Reject',
				actor: CAROL,
				object: carolFollow,
			});

			expect((await getRelations('following')).size).toBe(0);
			expect(await getCounts()).toEqual({ followers: 0, following: 0 });
			await expectConsistent();
		});
	});

	describe('rebuildFollowProjection (backfill)', () => {
		test('rebuilds the same projection and counters as the incremental updates', async () => {
			await followMe('https://remote.example/follows/alice-1', ALICE);
			await followMe('https://remote.example/follows/bob-1', BOB);
			await mastodonFollow(BOB);
			await mastodonFollow(CAROL);
			const [bobFollow] = await outgoingFollowIris(BOB);
			await postInbox({ id: `${bobFollow}#accept`, type: 'Accept', actor: BOB, object: bobFollow });

			const incremental = {
				followers: await getRelations('followers'),
				following: await getRelations('following'),
				counts: await getCounts(),
			};
			// 差分更新の結果と一致していれば、何も書き込まない
			expect(await rebuildFollowProjection()).toEqual({
				written: 0,
				deleted: 0,
				followers: 2,
				following: 1,
			});

			// 射影とカウンタを壊してから組み立て直す
			const userInfoKey = escapeFirestoreKey(me.id);
			await FollowRelations(userInfoKey, 'followers').doc(escapeFirestoreKey(ALICE)).delete();
			await FollowRelations(userInfoKey, 'following')
				.doc(escapeFirestoreKey('https://remote.example/u/stale'))
				.set({ ...incremental.following.get(CAROL)!, actor: 'https://remote.example/u/stale' });
			await UserInfos.doc(userInfoKey).update({ followers_count: 19, following_count: 0 });

			expect(await rebuildFollowProjection()).toMatchObject({ written: 1, deleted: 1 });
			const strip = (relations: Map<string, FollowRelation>) =>
				new Map([...relations].map(([key, { createdAt: _, ...rest }]) => [key, rest]));
			expect(strip(await getRelations('followers'))).toEqual(strip(incremental.followers));
			expect(strip(await getRelations('following'))).toEqual(strip(incremental.following));
			expect(await getCounts()).toEqual(incremental.counts);
			await expectConsistent();
		});
	});

	describe('followContributions', () => {
		test('ignores non-Follow activities and unrelated Follows', () => {
			expect(followContributions(undefined)).toEqual([]);
			expect(
				followContributions({ id: 'x', type: 'Like', actor: me.id, object: ALICE } as APObject),
			).toEqual([]);
			expect(
				followContributions({ id: 'x', type: 'Follow', actor: ALICE, object: BOB } as APObject),
			).toEqual([]);
		});

		test('does not count a received Follow until it is in the followers collection', () => {
			expect(
				followContributions({
					id: 'x',
					type: 'Follow',
					actor: [ALICE],
					object: [me.id],
					_meta: { collection: [`${me.id}/inbox`] },
				} as APObject),
			).toEqual([]);
		});
	});
});
