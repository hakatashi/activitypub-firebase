import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { buildMetaIndex } from '../../src/meta.js';
import { Streams } from '../../src/schema.js';
import {
	collectFollowers,
	collectFollowing,
	getFollowerActorIris,
	getFollowing,
	getPendingFollowTargetIris,
	resolveOutgoingFollows,
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

const saveStream = (id: string, activity: Record<string, unknown>) =>
	Streams.doc(escapeFirestoreKey(id)).set({
		...activity,
		id,
		_meta: { index: buildMetaIndex(activity) },
	} as never);

describe('social/follows', () => {
	beforeEach(async () => {
		await apex.store.saveObject(me);
	});

	afterEach(async () => {
		await resetFirestore();
	});

	describe('outgoing follows (resolveOutgoingFollows / getFollowing / getPendingFollowTargetIris)', () => {
		test('categorizes accepted, pending, and undone follows correctly', async () => {
			// 1. Follow to ALICE: Accepted
			await saveStream('follow-alice', {
				type: 'Follow',
				actor: [me.id],
				object: [ALICE],
				published: '2026-01-01T00:00:00Z',
			});
			await saveStream('accept-alice', {
				type: 'Accept',
				actor: [ALICE],
				object: ['follow-alice'],
				_meta: { collection: [me.inbox as string] },
			});

			// 2. Follow to BOB: Pending (not accepted yet)
			await saveStream('follow-bob', {
				type: 'Follow',
				actor: [me.id],
				object: [BOB],
				published: '2026-01-02T00:00:00Z',
			});

			// 3. Follow to CAROL: Accepted but later undone by me
			await saveStream('follow-carol', {
				type: 'Follow',
				actor: [me.id],
				object: [CAROL],
				published: '2026-01-03T00:00:00Z',
			});
			await saveStream('accept-carol', {
				type: 'Accept',
				actor: [CAROL],
				object: ['follow-carol'],
				_meta: { collection: [me.inbox as string] },
			});
			await saveStream('undo-carol', {
				type: 'Undo',
				actor: [me.id],
				object: ['follow-carol'],
			});

			const { following, pending } = await resolveOutgoingFollows(me);

			expect(Array.from(following.keys())).toEqual([ALICE]);
			expect(Array.from(pending)).toEqual([BOB]);

			// Derived functions
			expect(await getFollowing(me)).toEqual([ALICE]);
			expect(await getPendingFollowTargetIris(me)).toEqual(new Set([BOB]));
		});

		test('deduplicates multiple follows to the same actor', async () => {
			await saveStream('follow-alice-1', {
				type: 'Follow',
				actor: [me.id],
				object: [ALICE],
				published: '2026-01-01T00:00:00Z',
			});
			await saveStream('follow-alice-2', {
				type: 'Follow',
				actor: [me.id],
				object: [ALICE],
				published: '2026-01-02T00:00:00Z',
			});
			await saveStream('accept-alice-1', {
				type: 'Accept',
				actor: [ALICE],
				object: ['follow-alice-1'],
				_meta: { collection: [me.inbox as string] },
			});
			await saveStream('accept-alice-2', {
				type: 'Accept',
				actor: [ALICE],
				object: ['follow-alice-2'],
				_meta: { collection: [me.inbox as string] },
			});

			const following = await collectFollowing(me);
			expect(Array.from(following.keys())).toEqual([ALICE]);
			expect(following.get(ALICE)?.followIri).toBe('follow-alice-1');
		});
	});

	describe('incoming follows (collectFollowers / getFollowerActorIris)', () => {
		test('collects followers excluding undone follows', async () => {
			// Alice follows me
			await saveStream('follow-from-alice', {
				type: 'Follow',
				actor: [ALICE],
				object: [me.id],
				published: '2026-01-01T00:00:00Z',
			});

			// Bob follows me then undos
			await saveStream('follow-from-bob', {
				type: 'Follow',
				actor: [BOB],
				object: [me.id],
				published: '2026-01-02T00:00:00Z',
			});
			await saveStream('undo-from-bob', {
				type: 'Undo',
				actor: [BOB],
				object: ['follow-from-bob'],
				_meta: { collection: [me.inbox as string] },
			});

			const followers = await collectFollowers(me);
			expect(Array.from(followers.keys())).toEqual([ALICE]);
			expect(await getFollowerActorIris(me)).toEqual([ALICE]);
		});
	});
});
