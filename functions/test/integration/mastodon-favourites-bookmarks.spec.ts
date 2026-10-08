import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { plainTextToHtml, publishNote } from '../../src/notes.js';
import { Bookmarks } from '../../src/schema.js';
import { addBookmark, backfillBookmarkCursors } from '../../src/social/bookmarks.js';
import {
	addAccessToken,
	createLocalActor,
	mastodon as mastodonReq,
	resetFirestore,
} from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const UID_ALICE = 'uid-alice';

const collections = [
	{ name: 'favourites', add: 'favourite', remove: 'unfavourite' },
	{ name: 'bookmarks', add: 'bookmark', remove: 'unbookmark' },
] as const;

// `Link` ヘッダの rel に対応する URL を、テスト用リクエストのパスに直す。
const getLinkPath = (link: string | undefined, rel: 'next' | 'prev') => {
	const match = link?.match(new RegExp(`<([^>]+)>; rel="${rel}"`));
	if (match?.[1] === undefined) {
		return undefined;
	}
	const url = new URL(match[1]);
	return `${url.pathname}${url.search}`;
};

describe('GET /api/v1/favourites and /api/v1/bookmarks (Issue #223, ADR-0100)', () => {
	let me: LocalActor;
	let alice: LocalActor;
	let notes: APObject[];
	let statusIds: string[];

	const publish = async (content: string, visibility: 'public' | 'private' = 'public') => {
		const { object } = await publishNote(alice, { content: plainTextToHtml(content), visibility });
		return object;
	};

	const action = async (name: string, statusId: string, token = 'me-token') => {
		const res = await mastodonReq.post(`/api/v1/statuses/${statusId}/${name}`, token);
		expect(res.status).toBe(200);
	};

	const list = async (path: string, token = 'me-token') => {
		const res = await mastodonReq.get(path, token);
		expect(res.status).toBe(200);
		return {
			ids: (res.body as { id: string }[]).map((status) => status.id),
			body: res.body as { id: string; favourited: boolean; bookmarked: boolean }[],
			link: res.headers.link as string | undefined,
		};
	};

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);
		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
		alice = await createLocalActor('alice', { uid: UID_ALICE, id: '2' });
		await addAccessToken('me-token', 'read write', UID_ME);
		await addAccessToken('alice-token', 'read write', UID_ALICE);
		await addAccessToken('me-statuses-token', 'read:statuses', UID_ME);
		notes = [];
		for (const content of ['first', 'second', 'third']) {
			notes.push(await publish(content));
		}
		const ids = await getMastodonIds(
			notes.map((note) => ({ iri: note.id, published: note.published })),
		);
		statusIds = notes.map((note) => ids.get(note.id)!);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe.each(collections)('$name', ({ name, add, remove }) => {
		test('requires authentication and the read scope', async () => {
			expect((await mastodonReq.get(`/api/v1/${name}`)).status).toBe(401);
			expect((await mastodonReq.get(`/api/v1/${name}`, 'me-statuses-token')).status).toBe(403);
		});

		test('returns an empty list without a Link header', async () => {
			const { ids, link } = await list(`/api/v1/${name}`);
			expect(ids).toEqual([]);
			expect(link).toBeUndefined();
		});

		test('returns statuses newest-first in the order they were added, and pages with Link', async () => {
			// 投稿順 (0, 1, 2) とは違う順に追加する
			for (const index of [1, 2, 0]) {
				await action(add, statusIds[index]!);
			}
			const expected = [0, 2, 1].map((index) => statusIds[index]);

			const all = await list(`/api/v1/${name}`);
			expect(all.ids).toEqual(expected);
			expect(
				all.body.every((status) => status[name === 'favourites' ? 'favourited' : 'bookmarked']),
			).toBe(true);

			const first = await list(`/api/v1/${name}?limit=2`);
			expect(first.ids).toEqual(expected.slice(0, 2));
			// カーソルは Status の ID ではない
			const nextPath = getLinkPath(first.link, 'next');
			expect(nextPath).toBeDefined();
			expect(nextPath).toContain('limit=2');
			expect(statusIds.some((id) => nextPath!.includes(id))).toBe(false);

			const second = await list(nextPath!);
			expect(second.ids).toEqual(expected.slice(2));

			const third = await list(getLinkPath(second.link, 'next')!);
			expect(third.ids).toEqual([]);
			expect(third.link).toBeUndefined();

			// prev (min_id) で新しい側へ戻る
			const back = await list(getLinkPath(second.link, 'prev')!);
			expect(back.ids).toEqual(expected.slice(0, 2));
		});

		test('excludes removed entries and Tombstones', async () => {
			for (const statusId of statusIds) {
				await action(add, statusId);
			}
			await action(remove, statusIds[1]!);
			const deleteRes = await mastodonReq.delete(`/api/v1/statuses/${statusIds[0]}`, 'alice-token');
			expect(deleteRes.status).toBe(200);

			const { ids } = await list(`/api/v1/${name}`);
			expect(ids).toEqual([statusIds[2]]);
		});

		test('skips invisible statuses and still fills the page', async () => {
			for (const statusId of statusIds) {
				await action(add, statusId);
			}
			const { ids, link } = await list(`/api/v1/${name}?limit=2`);
			expect(ids).toEqual([statusIds[2], statusIds[1]]);

			// 先頭の 1 件を閲覧できなくする
			await apex.store.updateObject(
				{ ...notes[2]!, to: [`${alice.id}/followers`], cc: [] } as APObject,
				alice.id,
				true,
			);
			const after = await list(`/api/v1/${name}?limit=2`);
			expect(after.ids).toEqual([statusIds[1], statusIds[0]]);
			expect(getLinkPath(after.link, 'next')).not.toBe(getLinkPath(link, 'next'));
			const rest = await list(getLinkPath(after.link, 'next')!);
			expect(rest.ids).toEqual([]);
		});
	});

	test('re-bookmarking keeps the original position', async () => {
		for (const statusId of statusIds) {
			await action('bookmark', statusId);
		}
		await action('bookmark', statusIds[0]!);
		expect((await list('/api/v1/bookmarks')).ids).toEqual([...statusIds].reverse());
	});

	test('a bookmark of a private status from an unfollowed author is not listed', async () => {
		const privateNote = await publish('followers only', 'private');
		await action('bookmark', statusIds[0]!);
		await addBookmark(me.id, privateNote.id);
		expect((await list('/api/v1/bookmarks')).ids).toEqual([statusIds[0]]);
	});

	test('backfill fills cursorId of bookmarks created before ADR-0100', async () => {
		const bookmarks = Bookmarks(escapeFirestoreKey(me.id));
		for (const [index, note] of notes.entries()) {
			await bookmarks.doc(escapeFirestoreKey(note.id)).set({
				noteIri: note.id,
				createdAt: new Date(Date.UTC(2026, 0, 1 + index)),
			} as never);
		}
		expect((await list('/api/v1/bookmarks')).ids).toEqual([]);

		expect(await backfillBookmarkCursors(me.id, { dryRun: true })).toEqual({
			total: 3,
			written: 3,
		});
		expect(await backfillBookmarkCursors(me.id)).toEqual({ total: 3, written: 3 });
		expect(await backfillBookmarkCursors(me.id)).toEqual({ total: 3, written: 0 });
		expect((await list('/api/v1/bookmarks')).ids).toEqual([...statusIds].reverse());
	});
});
