import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { buildMastodonId } from '../../src/mastodonId.js';
import { FollowRelations } from '../../src/schema.js';
import type { FollowRelationSide, FollowState } from '../../src/schema.js';
import {
	getFollowFlags,
	getFollowIri,
	getFollowerActorIris,
	getFollowersPageEntries,
	getFollowing,
	getFollowingPageEntries,
	getPendingFollowTargetIris,
} from '../../src/social/follows.js';
import { resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const me = {
	id: 'https://example.com/u/me',
	type: 'Person',
	preferredUsername: 'me',
	inbox: 'https://example.com/u/me/inbox',
} as unknown as LocalActor;

const ALICE = 'https://remote.example/u/alice';
const BOB = 'https://remote.example/u/bob';
const CAROL = 'https://remote.example/u/carol';
const DAVE = 'https://remote.example/u/dave';

const baseTime = Date.parse('2026-01-01T00:00:00.000Z');

// 読み取り側のテストなので、射影 (→ ADR-0082) を直接書いておく。射影の差分更新は
// follow-projection.spec.ts が確かめる。
// oxlint-disable-next-line max-params
const setRelation = (
	side: FollowRelationSide,
	counterpart: string,
	state: FollowState,
	mastodonId: string | null,
) => {
	const followIri = `${counterpart}#follow`;
	return FollowRelations(escapeFirestoreKey(me.id), side)
		.doc(escapeFirestoreKey(counterpart))
		.set({
			actor: counterpart,
			followIri,
			followMastodonId: mastodonId,
			state,
			createdAt: new Date() as never,
			follows: [{ iri: followIri, state, mastodonId }],
		});
};

const idAt = (minutes: number) => buildMastodonId(baseTime + minutes * 60_000, 0);

describe('social/follows (projection reads, ADR-0083)', () => {
	beforeEach(async () => {
		await apex.store.saveObject(me);
	});

	afterEach(async () => {
		await resetFirestore();
	});

	test('reads accepted, pending, and followers from the projection', async () => {
		await setRelation('following', ALICE, 'accepted', idAt(1));
		await setRelation('following', BOB, 'pending', idAt(2));
		await setRelation('followers', CAROL, 'accepted', idAt(3));
		await setRelation('followers', ALICE, 'accepted', idAt(4));

		expect(await getFollowing(me)).toEqual([ALICE]);
		expect(await getPendingFollowTargetIris(me)).toEqual(new Set([BOB]));
		expect(new Set(await getFollowerActorIris(me))).toEqual(new Set([ALICE, CAROL]));
	});

	test('returns empty results for an actor without a projection (remote actor)', async () => {
		await setRelation('followers', CAROL, 'accepted', idAt(1));
		const remote = { id: ALICE, type: 'Person' } as unknown as LocalActor;

		expect(await getFollowing(remote)).toEqual([]);
		expect(await getFollowerActorIris(remote)).toEqual([]);
		expect(await getFollowersPageEntries(remote)).toEqual([]);
	});

	test('getFollowFlags resolves each target in the given order', async () => {
		await setRelation('following', ALICE, 'accepted', idAt(1));
		await setRelation('following', BOB, 'pending', idAt(2));
		await setRelation('followers', ALICE, 'accepted', idAt(3));
		await setRelation('followers', CAROL, 'accepted', idAt(4));

		expect(await getFollowFlags(me, [CAROL, ALICE, DAVE, BOB])).toEqual([
			{ following: false, requested: false, followedBy: true },
			{ following: true, requested: false, followedBy: true },
			{ following: false, requested: false, followedBy: false },
			{ following: false, requested: true, followedBy: false },
		]);
		expect(await getFollowFlags(me, [])).toEqual([]);
	});

	test('getFollowIri returns the representative Follow of the following side only', async () => {
		await setRelation('following', ALICE, 'accepted', idAt(1));
		await setRelation('following', BOB, 'pending', idAt(2));
		await setRelation('followers', CAROL, 'accepted', idAt(3));

		expect(await getFollowIri(me, ALICE)).toBe(`${ALICE}#follow`);
		expect(await getFollowIri(me, BOB)).toBe(`${BOB}#follow`);
		expect(await getFollowIri(me, CAROL)).toBeUndefined();
		expect(await getFollowIri(me, DAVE)).toBeUndefined();
	});

	describe('pagination by the Mastodon ID of the Follow (ADR-0062)', () => {
		const actorIris = (entries: { actorIri: string }[]) => entries.map(({ actorIri }) => actorIri);

		beforeEach(async () => {
			for (const [i, iri] of [ALICE, BOB, CAROL, DAVE].entries()) {
				await setRelation('followers', iri, 'accepted', idAt(i));
			}
		});

		test('walks back with max_id and forward with min_id / since_id', async () => {
			const first = await getFollowersPageEntries(me, { limit: 2 });
			expect(actorIris(first)).toEqual([DAVE, CAROL]);
			expect(first.map(({ cursorId }) => cursorId)).toEqual([idAt(3), idAt(2)]);

			const second = await getFollowersPageEntries(me, { limit: 2, maxId: idAt(2) });
			expect(actorIris(second)).toEqual([BOB, ALICE]);
			expect(await getFollowersPageEntries(me, { limit: 2, maxId: idAt(0) })).toEqual([]);

			// min_id はカーソルに隣接する古い側から、since_id は新しい側から埋める
			expect(actorIris(await getFollowersPageEntries(me, { limit: 2, minId: idAt(0) }))).toEqual([
				CAROL,
				BOB,
			]);
			expect(actorIris(await getFollowersPageEntries(me, { limit: 2, sinceId: idAt(0) }))).toEqual([
				DAVE,
				CAROL,
			]);
			expect(
				actorIris(await getFollowersPageEntries(me, { limit: 5, minId: idAt(0), maxId: idAt(3) })),
			).toEqual([CAROL, BOB]);
		});

		test('skips relations without a Mastodon ID', async () => {
			await setRelation('followers', 'https://remote.example/u/eve', 'accepted', null);
			expect(actorIris(await getFollowersPageEntries(me, { limit: 10 }))).toEqual([
				DAVE,
				CAROL,
				BOB,
				ALICE,
			]);
		});
	});

	test('following pages exclude pending follows', async () => {
		await setRelation('following', ALICE, 'accepted', idAt(1));
		await setRelation('following', BOB, 'pending', idAt(2));
		await setRelation('following', CAROL, 'accepted', idAt(3));

		const entries = await getFollowingPageEntries(me, { limit: 1 });
		expect(entries).toEqual([{ actorIri: CAROL, cursorId: idAt(3) }]);
		expect(await getFollowingPageEntries(me, { limit: 5, maxId: idAt(3) })).toEqual([
			{ actorIri: ALICE, cursorId: idAt(1) },
		]);
	});
});
