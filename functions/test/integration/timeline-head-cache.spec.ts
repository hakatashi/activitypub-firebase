import type { APObject } from '../../src/apex/index.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { clearTimelineHeadCache } from '../../src/mastodon/presenters/timelineHeadCache.js';
import { createList } from '../../src/social/lists.js';
import {
	addAccessToken,
	createLocalActor,
	enableTimelineFeeds,
	mastodon as mastodonReq,
	resetFirestore,
} from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const REMOTE_A = 'https://remote.example/u/alice';
const REMOTE_B = 'https://remote.example/u/bob';
const TOKEN = 'me-token';

interface Status {
	id: string;
	uri: string;
	content: string;
	favourited: boolean;
	reblog: Status | null;
}

// ホーム・リストのタイムラインの先頭ページのキャッシュ (→ ADR-0139)。
describe('timeline head cache (Issue #347, ADR-0139)', () => {
	let me: LocalActor;
	let n = 0;

	const noteObject = (attributedTo: string, index: number, extra: Record<string, unknown> = {}) =>
		({
			id: `${attributedTo}/notes/${index}`,
			type: 'Note',
			attributedTo,
			content: `note-${index}`,
			published: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
			to: [PUBLIC],
			cc: [`${attributedTo}/followers`],
			...extra,
		}) as unknown as APObject;

	const saveNote = async (attributedTo: string, extra: Record<string, unknown> = {}) => {
		n++;
		const note = noteObject(attributedTo, n, extra);
		await apex.store.saveObject(note);
		return note.id!;
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

	const follow = async (target: string) => {
		const activity = {
			id: `${me.id}/follows/${encodeURIComponent(target)}`,
			type: 'Follow',
			actor: me.id,
			object: target,
		} as APObject;
		await apex.store.saveActivity(activity);
		await apex.store.updateActivityMeta(activity, 'collection', `${me.id}/following`, false);
	};

	const getStatuses = async (path: string) => {
		const res = await mastodonReq.get(path, TOKEN);
		expect(res.status).toBe(200);
		return res.body as Status[];
	};
	const home = (query = 'limit=3') => getStatuses(`/api/v1/timelines/home?${query}`);

	// キャッシュを使わずに組み立てた結果と同じか確かめる。
	const expectSameAsUncached = async (statuses: Status[], query = 'limit=3') => {
		clearTimelineHeadCache();
		expect(statuses).toEqual(await home(query));
	};

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		me = await createLocalActor('hakatashi', { uid: 'uid-me', id: '1' });
		await addAccessToken(TOKEN, 'read write follow', 'uid-me');
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
		await follow(REMOTE_A);
		await follow(REMOTE_B);
		await enableTimelineFeeds(me.id);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	test('returns the cached page for remote edits until it expires', async () => {
		const a1 = await saveNote(REMOTE_A);
		const first = await home();
		expect(first.map((status) => status.uri)).toEqual([a1]);

		// リモートの編集は無効化しない (→ ADR-0139 決定5)。
		await apex.store.updateObject(noteObject(REMOTE_A, 1, { content: 'edited' }), REMOTE_A, true);
		expect(await home()).toEqual(first);

		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 15 * 60 * 1000);
		expect((await home())[0]?.content).toBe('edited');
	});

	test('adds new entries on top of the cached page', async () => {
		const a1 = await saveNote(REMOTE_A);
		const b2 = await saveNote(REMOTE_B);
		expect((await home()).map((status) => status.uri)).toEqual([b2, a1]);

		const a3 = await saveNote(REMOTE_A);
		const a4 = await saveNote(REMOTE_A, { to: [`${REMOTE_A}/followers`], cc: [] });
		const statuses = await home();
		expect(statuses.map((status) => status.uri)).toEqual([a4, a3, b2]);
		await expectSameAsUncached(statuses);
	});

	test('keeps only the newest boost of the same note when adding new entries', async () => {
		const a1 = await saveNote(REMOTE_A);
		const a2 = await saveNote(REMOTE_A);
		const boostA = await saveAnnounce(REMOTE_A, a1);
		expect((await home()).map((status) => status.uri)).toEqual([boostA, a2, a1]);

		const boostB = await saveAnnounce(REMOTE_B, a1);
		const statuses = await home();
		expect(statuses.map((status) => status.uri)).toEqual([boostB, a2, a1]);
		await expectSameAsUncached(statuses);
	});

	test('reflects the viewer actions through the Mastodon API immediately', async () => {
		await saveNote(REMOTE_A);
		const [status] = await home();
		expect(status?.favourited).toBe(false);

		const res = await mastodonReq.post(`/api/v1/statuses/${status!.id}/favourite`, TOKEN);
		expect(res.status).toBe(200);
		expect((await home())[0]?.favourited).toBe(true);
	});

	test('hides private posts of an unfollowed actor', async () => {
		await saveNote(REMOTE_B);
		await saveNote(REMOTE_A, { to: [`${REMOTE_A}/followers`], cc: [] });
		const before = await home();
		expect(before).toHaveLength(2);

		const account = await getStatuses(`/api/v1/accounts/search?q=alice@remote.example`);
		const res = await mastodonReq.post(`/api/v1/accounts/${account[0]!.id}/unfollow`, TOKEN);
		expect(res.status).toBe(200);
		expect((await home()).map((status) => status.uri)).toEqual([before[1]?.uri]);
	});

	test('caches list timelines separately and invalidates them on list changes', async () => {
		const list = await createList(me.id, { title: 'TSG', repliesPolicy: 'list', exclusive: false });
		const a1 = await saveNote(REMOTE_A);
		await saveNote(REMOTE_B);
		const path = `/api/v1/timelines/list/${list!.id}?limit=3`;
		expect(await getStatuses(path)).toEqual([]);

		const account = await getStatuses(`/api/v1/accounts/search?q=alice@remote.example`);
		const res = await mastodonReq
			.post(`/api/v1/lists/${list!.id}/accounts`, TOKEN)
			.send({ account_ids: [account[0]!.id] });
		expect(res.status).toBe(200);
		expect((await getStatuses(path)).map((status) => status.uri)).toEqual([a1]);
		expect(await home()).toHaveLength(2);
	});

	test('caches pages with only max_id until it expires (ADR-0147)', async () => {
		await saveNote(REMOTE_A);
		const a2 = await saveNote(REMOTE_A);
		const [newest] = await home('limit=1');
		expect(newest?.uri).toBe(a2);
		const query = `limit=1&max_id=${newest!.id}`;

		const older = await home(query);
		await apex.store.updateObject(noteObject(REMOTE_A, 1, { content: 'edited' }), REMOTE_A, true);
		// 新着は max_id のページに入らない。
		await saveNote(REMOTE_B);
		expect(await home(query)).toEqual(older);

		const now = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(now + 15 * 60 * 1000);
		expect(await home(query)).toEqual([{ ...older[0], content: 'edited' }]);
	});

	test('reflects the viewer actions and unfollows on pages with max_id (ADR-0147)', async () => {
		await saveNote(REMOTE_A, { to: [`${REMOTE_A}/followers`], cc: [] });
		await saveNote(REMOTE_B);
		const a3 = await saveNote(REMOTE_A);
		const [newest] = await home('limit=1');
		expect(newest?.uri).toBe(a3);
		const query = `limit=3&max_id=${newest!.id}`;
		const older = await home(query);
		expect(older).toHaveLength(2);
		expect(older[0]?.favourited).toBe(false);

		const res = await mastodonReq.post(`/api/v1/statuses/${older[0]!.id}/favourite`, TOKEN);
		expect(res.status).toBe(200);
		expect((await home(query))[0]?.favourited).toBe(true);

		const account = await getStatuses(`/api/v1/accounts/search?q=alice@remote.example`);
		const unfollow = await mastodonReq.post(`/api/v1/accounts/${account[0]!.id}/unfollow`, TOKEN);
		expect(unfollow.status).toBe(200);
		expect((await home(query)).map((status) => status.uri)).toEqual([older[0]?.uri]);
	});

	test('does not cache pages with since_id', async () => {
		const a1 = await saveNote(REMOTE_A);
		await saveNote(REMOTE_A);
		const [, oldest] = await home();
		expect(oldest?.uri).toBe(a1);

		const query = `limit=1&since_id=${oldest!.id}`;
		const [first] = await home(query);
		await apex.store.updateObject(noteObject(REMOTE_A, 2, { content: 'edited' }), REMOTE_A, true);
		expect((await home(query))[0]).toEqual({ ...first, content: 'edited' });
	});
});
