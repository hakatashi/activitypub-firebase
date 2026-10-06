import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { plainTextToHtml, publishNote } from '../../src/notes.js';
import { rebuildReactionProjection } from '../../src/projections/reactions.js';
import { ReactionRelations, Streams } from '../../src/schema.js';
import type { ReactionKind, ReactionRelation } from '../../src/schema.js';
import { toIdArray } from '../../src/utils.js';
import {
	addAccessToken,
	createLocalActor,
	mastodon as mastodonReq,
	resetFirestore,
} from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const UID_ALICE = 'uid-alice';
const REMOTE_BOB = 'https://remote.example/u/bob';

describe('favourite / reblog projection (Issue #195, ADR-0084)', () => {
	let me: LocalActor;
	let alice: LocalActor;
	let note: APObject;
	let statusId: string;

	const action = async (name: string, id = statusId) => {
		const res = await mastodonReq.post(`/api/v1/statuses/${id}/${name}`, 'me-token');
		expect(res.status).toBe(200);
		return res.body as { favourited: boolean; reblogged: boolean };
	};

	const getStatus = async (token = 'me-token') => {
		const res = await mastodonReq.get(`/api/v1/statuses/${statusId}`, token);
		expect(res.status).toBe(200);
		return res.body as { favourited: boolean; reblogged: boolean };
	};

	const getRelations = async (kind: ReactionKind) => {
		const docs = await ReactionRelations(escapeFirestoreKey(me.id), kind).get();
		return new Map<string, ReactionRelation>(
			docs.docs.map((doc) => [doc.data().object, doc.data()]),
		);
	};

	const streamActivityIris = async (type: string) => {
		const docs = await Streams.where('type', '==', type).get();
		return docs.docs
			.map((doc) => doc.data())
			.filter((activity) => toIdArray(activity.actor).includes(me.id))
			.map((activity) => activity.id);
	};

	// 射影が、streams に残っているローカル actor の Like / Announce と食い違わないことを確かめる。
	const expectConsistent = async () => {
		for (const [kind, type] of [
			['favourites', 'Like'],
			['reblogs', 'Announce'],
		] as const) {
			const relations = await getRelations(kind);
			const projected = [...relations.values()].flatMap(({ activityIris }) => activityIris);
			expect(projected.toSorted()).toEqual((await streamActivityIris(type)).toSorted());
		}
	};

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);
		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
		alice = await createLocalActor('alice', { uid: UID_ALICE, id: '2' });
		await addAccessToken('me-token', 'read write', UID_ME);
		await addAccessToken('alice-token', 'read write', UID_ALICE);
		({ object: note } = await publishNote(alice, {
			content: plainTextToHtml('Post to react'),
			visibility: 'public',
		}));
		const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
		statusId = ids.get(note.id)!;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	test('favourite / unfavourite keeps the projection in sync, and repeats are no-ops', async () => {
		expect((await action('favourite')).favourited).toBe(true);
		expect((await action('favourite')).favourited).toBe(true);

		const favourites = await getRelations('favourites');
		expect([...favourites.keys()]).toEqual([note.id]);
		expect(favourites.get(note.id)?.activityIris).toEqual(await streamActivityIris('Like'));
		expect(await streamActivityIris('Like')).toHaveLength(1);
		await expectConsistent();
		expect((await getStatus()).favourited).toBe(true);
		expect((await getStatus('alice-token')).favourited).toBe(false);

		expect((await action('unfavourite')).favourited).toBe(false);
		expect((await action('unfavourite')).favourited).toBe(false);
		expect((await getRelations('favourites')).size).toBe(0);
		expect(await streamActivityIris('Like')).toHaveLength(0);
		// 2 回目の unfavourite では Undo を送らない
		expect(await streamActivityIris('Undo')).toHaveLength(1);
		await expectConsistent();

		// 取り消した後にもう一度お気に入りできる
		expect((await action('favourite')).favourited).toBe(true);
		expect((await getRelations('favourites')).get(note.id)?.activityIris).toHaveLength(1);
		await expectConsistent();
	});

	test('reblog / unreblog keeps the projection in sync, and repeats are no-ops', async () => {
		expect((await action('reblog')).reblogged).toBe(true);
		expect((await action('reblog')).reblogged).toBe(true);

		const reblogs = await getRelations('reblogs');
		expect([...reblogs.keys()]).toEqual([note.id]);
		expect(await streamActivityIris('Announce')).toHaveLength(1);
		expect((await getRelations('favourites')).size).toBe(0);
		await expectConsistent();
		expect((await getStatus()).reblogged).toBe(true);

		expect((await action('unreblog')).reblogged).toBe(false);
		expect((await action('unreblog')).reblogged).toBe(false);
		expect((await getRelations('reblogs')).size).toBe(0);
		expect(await streamActivityIris('Undo')).toHaveLength(1);
		await expectConsistent();
	});

	test('unfavourite undoes every live Like when the same Note was liked twice', async () => {
		for (let i = 0; i < 2; i++) {
			const like = await apex.buildActivity('Like', me.id, [alice.id], { object: note.id });
			await apex.addToOutbox(me, like);
		}
		expect((await getRelations('favourites')).get(note.id)?.activityIris).toHaveLength(2);
		await expectConsistent();

		expect((await action('unfavourite')).favourited).toBe(false);
		expect((await getRelations('favourites')).size).toBe(0);
		expect(await streamActivityIris('Like')).toHaveLength(0);
		expect(await streamActivityIris('Undo')).toHaveLength(2);
	});

	test('adding the Like to the liked collection does not change the projection', async () => {
		await action('favourite');
		const [likeIri] = await streamActivityIris('Like');
		const like = await apex.store.getActivity(likeIri!, true);
		await apex.store.updateActivityMeta(like!, 'collection', `${me.id}/liked`, false);
		await apex.store.saveActivity({
			...like!,
			_meta: { collection: [`${me.id}/outbox`, `${me.id}/liked`] },
		});

		expect((await getRelations('favourites')).get(note.id)?.activityIris).toEqual([likeIri]);
	});

	test('ignores Like / Announce from other actors', async () => {
		await apex.store.saveActivity({
			id: 'https://remote.example/likes/bob-1',
			type: 'Like',
			actor: REMOTE_BOB,
			object: note.id,
			_meta: { collection: [`${alice.id}/inbox`] },
		} as APObject);
		await apex.store.saveActivity({
			id: 'https://remote.example/announces/bob-1',
			type: 'Announce',
			actor: REMOTE_BOB,
			object: note.id,
			_meta: { collection: [`${alice.id}/inbox`] },
		} as APObject);
		const res = await mastodonReq.post(`/api/v1/statuses/${statusId}/favourite`, 'alice-token');
		expect(res.status).toBe(200);

		expect((await getRelations('favourites')).size).toBe(0);
		expect((await getRelations('reblogs')).size).toBe(0);
		expect((await getStatus()).favourited).toBe(false);
	});

	test('a remote Undo cannot remove the local Like from the projection', async () => {
		await action('favourite');
		const [likeIri] = await streamActivityIris('Like');
		await apex.store.removeActivity({ id: likeIri!, type: 'Like' } as APObject, REMOTE_BOB);

		expect((await getRelations('favourites')).get(note.id)?.activityIris).toEqual([likeIri]);
	});

	test('unfavourite drops projected IRIs whose activity is gone from streams', async () => {
		await action('favourite');
		const [likeIri] = await streamActivityIris('Like');
		await Streams.doc(escapeFirestoreKey(likeIri!)).delete();
		expect((await getStatus()).favourited).toBe(true);

		expect((await action('unfavourite')).favourited).toBe(false);
		expect((await getRelations('favourites')).size).toBe(0);
		expect(await streamActivityIris('Undo')).toHaveLength(0);
	});

	test('backfill rebuilds the same projection and is idempotent', async () => {
		await action('favourite');
		await action('reblog');
		const { object: other } = await publishNote(alice, {
			content: plainTextToHtml('Another post'),
			visibility: 'public',
		});
		// ADR-0070 の時期の、Undo されたまま streams に残っている Like (Store を通さずに書く)
		const legacyLike = {
			id: `${me.id}/legacy-like`,
			type: 'Like',
			actor: [me.id],
			object: other.id,
		};
		await Streams.doc(escapeFirestoreKey(legacyLike.id)).set(legacyLike as APObject);
		await Streams.doc(escapeFirestoreKey(`${me.id}/legacy-undo`)).set({
			id: `${me.id}/legacy-undo`,
			type: 'Undo',
			actor: [me.id],
			object: legacyLike,
		} as APObject);
		const expectedFavourites = await getRelations('favourites');
		const expectedReblogs = await getRelations('reblogs');

		// 射影を壊す: 正しいものを消し、余計なものを足す
		await ReactionRelations(escapeFirestoreKey(me.id), 'favourites')
			.doc(escapeFirestoreKey(note.id))
			.delete();
		await ReactionRelations(escapeFirestoreKey(me.id), 'reblogs')
			.doc(escapeFirestoreKey(other.id))
			.set(expectedReblogs.get(note.id)!);

		expect(await rebuildReactionProjection({ dryRun: true })).toMatchObject({
			written: 1,
			deleted: 1,
		});
		expect(await rebuildReactionProjection()).toEqual({
			written: 1,
			deleted: 1,
			favourites: 1,
			reblogs: 1,
			skippedUndone: 1,
		});
		const favourites = await getRelations('favourites');
		expect([...favourites.keys()]).toEqual([...expectedFavourites.keys()]);
		expect(favourites.get(note.id)?.activityIris).toEqual(
			expectedFavourites.get(note.id)?.activityIris,
		);
		expect(await getRelations('reblogs')).toEqual(expectedReblogs);

		expect(await rebuildReactionProjection()).toMatchObject({ written: 0, deleted: 0 });
	});
});
