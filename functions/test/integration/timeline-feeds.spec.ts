import type { APObject } from '../../src/apex/index.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey, toFirestoreKey } from '../../src/firebase.js';
import { getHomeTimeline, getListTimeline } from '../../src/mastodon/presenters/status.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import {
	rebuildTimelineFeeds,
	timelineFeedsMarkerRef,
} from '../../src/projections/timelineFeeds.js';
import { addListAccounts, createList, deleteList, getList } from '../../src/social/lists.js';
import { HomeFeed, ListFeed } from '../../src/schema.js';
import { resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const REMOTE_A = 'https://remote.example/u/alice';
const REMOTE_B = 'https://remote.example/u/bob';

// ホーム・リストのタイムラインの射影 (→ ADR-0136)。読み出しの結果は mastodon-timelines / mastodon-lists の
// [feed] で確かめているので、ここでは射影そのものの書き込みとバックフィルを確かめる。
describe('timeline feeds (Issue #343, ADR-0136)', () => {
	let me: LocalActor;
	let n = 0;

	const homeFeedIris = async () =>
		(await HomeFeed(escapeFirestoreKey(me.id)).orderBy('id', 'desc').get()).docs.map(
			(doc) => doc.data().iri,
		);
	const listFeedIris = async (listId: string) =>
		(
			await ListFeed(escapeFirestoreKey(me.id), toFirestoreKey(listId)).orderBy('id', 'desc').get()
		).docs.map((doc) => doc.data().iri);

	const saveNote = async (attributedTo: string, extra: Record<string, unknown> = {}) => {
		n++;
		const id = `${attributedTo}/notes/${n}`;
		await apex.store.saveObject({
			id,
			type: 'Note',
			attributedTo,
			content: `note-${n}`,
			published: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
			to: [PUBLIC],
			cc: [`${attributedTo}/followers`],
			...extra,
		} as unknown as APObject);
		return id;
	};

	const saveAnnounce = async (actor: string, object: string) => {
		n++;
		const id = `${actor}/announces/${n}`;
		await apex.store.saveActivity({
			id,
			type: 'Announce',
			actor,
			object,
			published: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
			to: [PUBLIC],
			cc: [`${actor}/followers`],
		} as unknown as APObject);
		return id;
	};

	const follow = async (target: string, accepted = true) => {
		const activity = {
			id: `${me.id}/follows/${encodeURIComponent(target)}`,
			type: 'Follow',
			actor: me.id,
			object: target,
		} as APObject;
		await apex.store.saveActivity(activity);
		if (accepted) {
			await apex.store.updateActivityMeta(activity, 'collection', `${me.id}/following`, false);
		}
	};

	const newList = async () => {
		const list = await createList(me.id, { title: 'TSG', repliesPolicy: 'list', exclusive: false });
		expect(list).toBeDefined();
		return list!;
	};

	beforeEach(async () => {
		me = (await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person')) as LocalActor;
		await apex.store.saveObject(me);
		for (const [id, name] of [
			[REMOTE_A, 'alice'],
			[REMOTE_B, 'bob'],
		] as const) {
			await apex.store.saveObject({
				id,
				type: 'Person',
				preferredUsername: name,
				inbox: `${id}/inbox`,
				outbox: `${id}/outbox`,
			} as unknown as APObject);
		}
		n = 0;
	});

	afterEach(async () => {
		await resetFirestore();
	});

	test('writes new notes and boosts of followed actors and self, keyed by Mastodon ID', async () => {
		await follow(REMOTE_A);
		await follow(REMOTE_B, false);
		const a1 = await saveNote(REMOTE_A);
		const b1 = await saveNote(REMOTE_B);
		const mine = await saveNote(me.id);
		const stranger = await saveNote('https://remote.example/u/stranger');
		const boost = await saveAnnounce(REMOTE_A, stranger);

		// 承認待ちの相手 (B) も候補として書く。読み出しで承認済みかを判定する。
		expect(await homeFeedIris()).toEqual([boost, mine, b1, a1]);

		const docs = (await HomeFeed(escapeFirestoreKey(me.id)).get()).docs;
		const ids = await getMastodonIds([{ iri: boost, published: undefined }]);
		const boostDoc = docs.find((doc) => doc.data().iri === boost);
		expect(boostDoc?.id).toBe(ids.get(boost));
		expect(boostDoc?.data()).toMatchObject({
			type: 'announce',
			actor: REMOTE_A,
			objectIri: stranger,
		});
	});

	test('does not rewrite the feed when an existing note is saved again', async () => {
		const a1 = await saveNote(REMOTE_A);
		await follow(REMOTE_A);
		await apex.store.saveObject({
			id: a1,
			type: 'Note',
			attributedTo: REMOTE_A,
			content: 'edited',
			published: new Date(Date.UTC(2026, 0, 1, 0, 1)).toISOString(),
			to: [PUBLIC],
		} as unknown as APObject);
		expect(await homeFeedIris()).toEqual([]);
	});

	test('writes to lists containing the author and merges past posts on adding members', async () => {
		await follow(REMOTE_A);
		await follow(REMOTE_B);
		const before = await saveNote(REMOTE_A);
		const list = await newList();
		expect(await addListAccounts(me, list.id, [REMOTE_A])).toEqual({ ok: true });
		expect(await listFeedIris(list.id)).toEqual([before]);

		const after = await saveNote(REMOTE_A);
		await saveNote(REMOTE_B);
		expect(await listFeedIris(list.id)).toEqual([after, before]);
		const listRecord = await getList(me.id, list.id);
		expect((await getListTimeline(me, listRecord!, { limit: 20 })).map((s) => s.uri)).toEqual([
			after,
			before,
		]);
	});

	test('deleting a list removes its feed', async () => {
		await follow(REMOTE_A);
		const list = await newList();
		await addListAccounts(me, list.id, [REMOTE_A]);
		await saveNote(REMOTE_A);
		expect(await listFeedIris(list.id)).toHaveLength(1);

		expect(await deleteList(me.id, list.id)).toBe(true);
		expect(await listFeedIris(list.id)).toEqual([]);
	});

	test('backfill rebuilds feeds from stored posts and enables reading from them', async () => {
		const a1 = await saveNote(REMOTE_A);
		const b1 = await saveNote(REMOTE_B);
		const boost = await saveAnnounce(REMOTE_A, b1);
		const mine = await saveNote(me.id);
		await follow(REMOTE_A);
		const list = await newList();
		await addListAccounts(me, list.id, [REMOTE_A]);
		// 射影を壊しておく (余計なエントリはバックフィルで消える)
		await HomeFeed(escapeFirestoreKey(me.id))
			.doc(toFirestoreKey('00000000000000000001'))
			.set({
				id: '00000000000000000001',
				type: 'note',
				iri: 'https://remote.example/notes/stale',
				actor: REMOTE_A,
				objectIri: null,
				createdAt: new Date() as never,
			});

		const dryRun = await rebuildTimelineFeeds({ dryRun: true });
		expect(dryRun.deleted).toBe(1);
		expect((await timelineFeedsMarkerRef(escapeFirestoreKey(me.id)).get()).exists).toBe(false);

		const stats = await rebuildTimelineFeeds();
		expect(stats).toMatchObject({ feeds: 2, deleted: 1 });
		expect(await homeFeedIris()).toEqual([mine, boost, a1]);
		expect(await listFeedIris(list.id)).toEqual([boost, a1]);
		expect((await timelineFeedsMarkerRef(escapeFirestoreKey(me.id)).get()).exists).toBe(true);
		expect((await getHomeTimeline(me, { limit: 20 })).map((s) => s.uri)).toEqual([mine, boost, a1]);

		// 2 回目は何も書かない
		expect(await rebuildTimelineFeeds()).toMatchObject({ written: 0, deleted: 0 });
	});
});
