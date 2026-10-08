import type { APObject } from '../../src/apex/index.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import {
	getAccountStatuses,
	getHomeTimeline,
	getPublicTimeline,
} from '../../src/mastodon/presenters/status.js';
import { getFollowing } from '../../src/social/follows.js';
import { resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const REMOTE_A = 'https://remote.example/u/alice';
const REMOTE_B = 'https://remote.example/u/bob';

describe('Mastodon timelines (Issue #58)', () => {
	let me: LocalActor;
	let n = 0;

	const saveNote = async (
		attributedTo: string,
		visibility: 'public' | 'unlisted' | 'private' | 'direct',
		extra: Record<string, unknown> = {},
	) => {
		n++;
		const followers = `${attributedTo}/followers`;
		const addressing = {
			public: { to: [PUBLIC], cc: [followers] },
			unlisted: { to: [followers], cc: [PUBLIC] },
			private: { to: [followers], cc: [] },
			direct: { to: [], cc: [] },
		}[visibility];
		const id = `${attributedTo}/notes/${n}`;
		await apex.store.saveObject({
			id,
			type: 'Note',
			attributedTo,
			content: `${visibility}-${n}`,
			published: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
			...addressing,
			...extra,
		} as unknown as APObject);
		return id;
	};

	const saveAnnounce = async (
		actor: string,
		targetNoteId: string,
		extra: Record<string, unknown> = {},
	) => {
		n++;
		const followers = `${actor}/followers`;
		const id = `${actor}/announces/${n}`;
		await apex.store.saveActivity({
			id,
			type: 'Announce',
			actor,
			object: targetNoteId,
			published: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
			to: [PUBLIC],
			cc: [followers],
			...extra,
		} as unknown as APObject);
		return id;
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

	// フォロー関係は Store が更新する射影から読む (→ ADR-0082, ADR-0083) ので、実際の流れと同じく
	// Store 経由で Follow を保存し、Accept されたら apex と同じく following コレクションに加える。
	const follow = async (target: string, accepted: boolean) => {
		const followId = `${me.id}/follows/${target}`;
		const activity = { id: followId, type: 'Follow', actor: me.id, object: target } as APObject;
		await apex.store.saveActivity(activity);
		if (accepted) {
			await apex.store.updateActivityMeta(activity, 'collection', `${me.id}/following`, false);
		}
	};

	test('public timeline contains only public notes', async () => {
		const publicId = await saveNote(REMOTE_A, 'public');
		await saveNote(REMOTE_A, 'unlisted');
		await saveNote(REMOTE_A, 'private');
		await saveNote(REMOTE_A, 'direct');
		const statuses = await getPublicTimeline({ limit: 20 });
		expect(statuses.map((s) => s.uri)).toEqual([publicId]);
		expect(statuses.every((s) => s.visibility === 'public')).toBe(true);
	});

	test('public timeline keeps reading past non-public notes until limit is filled', async () => {
		for (let i = 0; i < 5; i++) {
			await saveNote(REMOTE_A, 'public');
		}
		for (let i = 0; i < 20; i++) {
			await saveNote(REMOTE_A, 'private');
		}
		const statuses = await getPublicTimeline({ limit: 3 });
		expect(statuses).toHaveLength(3);
		expect(statuses.every((s) => s.visibility === 'public')).toBe(true);
	});

	test('account statuses are filtered by actor and viewer permissions', async () => {
		const a1 = await saveNote(REMOTE_A, 'public');
		const a2 = await saveNote(REMOTE_A, 'unlisted');
		await saveNote(REMOTE_A, 'private');
		await saveNote(REMOTE_A, 'direct');
		await saveNote(REMOTE_B, 'public');

		const anonymous = await getAccountStatuses(REMOTE_A, undefined, { limit: 20 });
		expect(anonymous.map((s) => s.uri).sort()).toEqual([a1, a2].sort());

		await follow(REMOTE_A, true);
		const asFollower = await getAccountStatuses(REMOTE_A, me, { limit: 20 });
		expect(asFollower.map((s) => s.visibility).sort()).toEqual(['private', 'public', 'unlisted']);
	});

	test('getFollowing ignores Follow that has not been accepted', async () => {
		await follow(REMOTE_A, true);
		await follow(REMOTE_B, false);
		expect(await getFollowing(me)).toEqual([REMOTE_A]);
	});

	test('home timeline has own and followed notes only, respecting visibility', async () => {
		const mine = await saveNote(me.id, 'direct');
		const followedPublic = await saveNote(REMOTE_A, 'public');
		const followedPrivate = await saveNote(REMOTE_A, 'private');
		await saveNote(REMOTE_A, 'direct');
		await saveNote(REMOTE_B, 'public');
		await follow(REMOTE_A, true);

		const statuses = await getHomeTimeline(me, { limit: 20 });
		expect(statuses.map((s) => s.uri).sort()).toEqual(
			[mine, followedPublic, followedPrivate].sort(),
		);
	});

	// inbox で受け取ったリモートの Note は apex が attributedTo を配列に正規化して保存する (→ ADR-0072)
	test('home timeline and account statuses include notes whose attributedTo is an array', async () => {
		const mine = await saveNote(me.id, 'public');
		const remote = await saveNote(REMOTE_A, 'public', { attributedTo: [REMOTE_A] });
		await saveNote(REMOTE_B, 'public', { attributedTo: [REMOTE_B] });
		await follow(REMOTE_A, true);

		const home = await getHomeTimeline(me, { limit: 20 });
		expect(home.map((s) => s.uri)).toEqual([remote, mine]);

		const account = await getAccountStatuses(REMOTE_A, me, { limit: 20 });
		expect(account.map((s) => s.uri)).toEqual([remote]);
	});

	describe('pagination (Issue #59)', () => {
		const seed = async (count: number) => {
			const uris: string[] = [];
			for (let i = 0; i < count; i++) {
				uris.push(await saveNote(REMOTE_A, 'public'));
			}
			return uris; // 古い順
		};

		test('max_id walks back through the timeline without overlap', async () => {
			const uris = await seed(5);
			const first = await getPublicTimeline({ limit: 2 });
			expect(first.map((s) => s.uri)).toEqual([uris[4], uris[3]]);
			const second = await getPublicTimeline({ limit: 2, maxId: first.at(-1)?.id });
			expect(second.map((s) => s.uri)).toEqual([uris[2], uris[1]]);
			const third = await getPublicTimeline({ limit: 2, maxId: second.at(-1)?.id });
			expect(third.map((s) => s.uri)).toEqual([uris[0]]);
			expect(await getPublicTimeline({ limit: 2, maxId: third.at(-1)?.id })).toEqual([]);
		});

		test('since_id fills from the newest side, min_id from the cursor side', async () => {
			const uris = await seed(5);
			const all = await getPublicTimeline({ limit: 5 });
			const oldestId = all.at(-1)?.id;
			const since = await getPublicTimeline({ limit: 2, sinceId: oldestId });
			expect(since.map((s) => s.uri)).toEqual([uris[4], uris[3]]);
			const min = await getPublicTimeline({ limit: 2, minId: oldestId });
			expect(min.map((s) => s.uri)).toEqual([uris[2], uris[1]]);
		});

		test('account statuses and home timeline honor the cursors', async () => {
			const uris = await seed(4);
			await follow(REMOTE_A, true);
			const all = await getAccountStatuses(REMOTE_A, me, { limit: 4 });
			const page = await getAccountStatuses(REMOTE_A, me, { limit: 2, maxId: all[1]?.id });
			expect(page.map((s) => s.uri)).toEqual([uris[1], uris[0]]);
			const home = await getHomeTimeline(me, { limit: 2, minId: all[3]?.id });
			expect(home.map((s) => s.uri)).toEqual([uris[2], uris[1]]);
		});

		test('notes with array-valued published are paged like any other (_meta.published)', async () => {
			const uris = await seed(2);
			const arrayId = `${REMOTE_A}/notes/array`;
			await apex.store.saveObject({
				id: arrayId,
				type: 'Note',
				attributedTo: REMOTE_A,
				content: 'array',
				published: [new Date(Date.UTC(2026, 0, 1, 0, 1, 30)).toISOString()],
				to: [PUBLIC],
				cc: [],
			} as unknown as APObject);

			const all = await getPublicTimeline({ limit: 10 });
			expect(all.map((s) => s.uri)).toEqual([uris[1], arrayId, uris[0]]);
			const older = await getPublicTimeline({ limit: 10, maxId: all[0]?.id });
			expect(older.map((s) => s.uri)).toEqual([arrayId, uris[0]]);
			const newer = await getPublicTimeline({ limit: 10, minId: all[2]?.id });
			expect(newer.map((s) => s.uri)).toEqual([uris[1], arrayId]);
		});

		test('pages keep filling past non-visible notes', async () => {
			const publicUris = await seed(3);
			for (let i = 0; i < 10; i++) {
				await saveNote(REMOTE_A, 'private');
			}
			const page = await getPublicTimeline({ limit: 2 });
			expect(page.map((s) => s.uri)).toEqual([publicUris[2], publicUris[1]]);
			const next = await getPublicTimeline({ limit: 2, maxId: page.at(-1)?.id });
			expect(next.map((s) => s.uri)).toEqual([publicUris[0]]);
		});
	});

	describe('boosts (Issue #225, ADR-0096)', () => {
		test('home timeline includes own and followed boosts at their boost time', async () => {
			const b1 = await saveNote(REMOTE_B, 'public');
			await saveAnnounce(REMOTE_A, b1);
			const myBoost = await saveAnnounce(me.id, b1);
			const myNote = await saveNote(me.id, 'public');

			await follow(REMOTE_A, true);

			const home = await getHomeTimeline(me, { limit: 20 });
			// 重複排除により、同じ b1 をブーストしたものは新しい方 (myBoost) が残る
			expect(home.map((s) => s.uri)).toEqual([myNote, myBoost]);
			expect(home[0]?.reblog).toBeNull();
			expect(home[1]?.reblog?.uri).toBe(b1);
			expect(home[1]?.account.username).toBe('hakatashi');
		});

		test('home timeline excludes boosts from unfollowed accounts', async () => {
			const b1 = await saveNote(REMOTE_B, 'public');
			await saveAnnounce(REMOTE_A, b1);

			const home = await getHomeTimeline(me, { limit: 20 });
			expect(home).toEqual([]);
		});

		test('account statuses include boosts and exclude_reblogs=true excludes them', async () => {
			const b1 = await saveNote(REMOTE_B, 'public');
			const a1 = await saveNote(REMOTE_A, 'public');
			const aBoost = await saveAnnounce(REMOTE_A, b1);

			const all = await getAccountStatuses(REMOTE_A, me, { limit: 20 });
			expect(all.map((s) => s.uri)).toEqual([aBoost, a1]);
			expect(all[0]?.reblog?.uri).toBe(b1);

			const withoutReblogs = await getAccountStatuses(
				REMOTE_A,
				me,
				{ limit: 20 },
				{ excludeReblogs: true },
			);
			expect(withoutReblogs.map((s) => s.uri)).toEqual([a1]);
		});

		test('pinned=true excludes boosts', async () => {
			const b1 = await saveNote(REMOTE_B, 'public');
			await saveAnnounce(REMOTE_A, b1);

			const pinned = await getAccountStatuses(REMOTE_A, me, { limit: 20 }, { pinned: true });
			expect(pinned).toEqual([]);
		});

		test('boosts of private notes or non-existent notes are excluded', async () => {
			const privNote = await saveNote(REMOTE_B, 'private');
			await saveAnnounce(REMOTE_A, privNote);
			await saveAnnounce(REMOTE_A, 'https://remote.example/non-existent');

			await follow(REMOTE_A, true);
			const home = await getHomeTimeline(me, { limit: 20 });
			expect(home).toEqual([]);
		});

		test('pagination mixes notes and boosts in order without duplication', async () => {
			const b1 = await saveNote(REMOTE_B, 'public');
			const b2 = await saveNote(REMOTE_B, 'public');
			const a1 = await saveNote(REMOTE_A, 'public');
			const aBoost = await saveAnnounce(REMOTE_A, b1);
			const a2 = await saveNote(REMOTE_A, 'public');
			const aBoost2 = await saveAnnounce(REMOTE_A, b2);

			const page1 = await getAccountStatuses(REMOTE_A, me, { limit: 2 });
			expect(page1.map((s) => s.uri)).toEqual([aBoost2, a2]);

			const page2 = await getAccountStatuses(REMOTE_A, me, { limit: 2, maxId: page1[1]?.id });
			expect(page2.map((s) => s.uri)).toEqual([aBoost, a1]);

			const pageRev = await getAccountStatuses(REMOTE_A, me, { limit: 2, minId: page2[0]?.id });
			expect(pageRev.map((s) => s.uri)).toEqual([aBoost2, a2]);
		});

		test('handles notes and boosts published at the same millisecond', async () => {
			const b1 = await saveNote(REMOTE_B, 'public');
			const sameTime = new Date(Date.UTC(2026, 0, 1, 12, 0, 0, 500)).toISOString();

			const noteId = `${REMOTE_A}/notes/same-time`;
			await apex.store.saveObject({
				id: noteId,
				type: 'Note',
				attributedTo: REMOTE_A,
				content: 'same-time-note',
				published: sameTime,
				to: [PUBLIC],
				cc: [],
			} as unknown as APObject);

			const boostId = `${REMOTE_A}/announces/same-time`;
			await apex.store.saveActivity({
				id: boostId,
				type: 'Announce',
				actor: REMOTE_A,
				object: b1,
				published: sameTime,
				to: [PUBLIC],
				cc: [],
			} as unknown as APObject);

			const statuses = await getAccountStatuses(REMOTE_A, me, { limit: 10 });
			expect(statuses).toHaveLength(2);
			expect(statuses.map((s) => s.uri).sort()).toEqual([noteId, boostId].sort());

			const first = statuses[0]!;
			const next = await getAccountStatuses(REMOTE_A, me, { limit: 10, maxId: first.id });
			expect(next).toHaveLength(1);
			expect(next[0]?.id).not.toBe(first.id);
		});
	});
});
