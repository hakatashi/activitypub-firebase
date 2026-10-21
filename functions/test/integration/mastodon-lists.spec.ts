import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/apex.js';
import { resolveAccountIds } from '../../src/mastodon/presenters/account.js';
import {
	addAccessToken,
	createLocalActor,
	enableTimelineFeeds,
	mastodon as mastodonReq,
	resetFirestore,
} from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const UID_ALICE = 'uid-alice';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const REMOTE_A = 'https://remote.example/u/alice';
const REMOTE_B = 'https://remote.example/u/bob';
const REMOTE_C = 'https://remote.example/u/carol';

interface ListBody {
	id: string;
	title: string;
	replies_policy: string;
	exclusive: boolean;
}

// `Link` ヘッダの rel に対応する URL を、テスト用リクエストのパスに直す。
const getLinkPath = (link: string | undefined, rel: 'next' | 'prev') => {
	const match = link?.match(new RegExp(`<([^>]+)>; rel="${rel}"`));
	if (match?.[1] === undefined) {
		return undefined;
	}
	const url = new URL(match[1]);
	return `${url.pathname}${url.search}`;
};

// タイムラインは従来の読み出し (scan) と射影 (feed。→ ADR-0136) の両方で同じ結果になることを確かめる。
describe.each(['scan', 'feed'] as const)(
	'Mastodon lists API (Issue #306, ADR-0134) [%s]',
	(mode) => {
		let me: LocalActor;
		let accountIds: Map<string, string>;
		let n = 0;

		const createList = async (body: Record<string, unknown>, token = 'me-token') => {
			const res = await mastodonReq.post('/api/v1/lists', token).send(body);
			expect(res.status).toBe(200);
			return res.body as ListBody;
		};

		const addAccounts = (listId: string, iris: string[], token = 'me-token') =>
			mastodonReq
				.post(`/api/v1/lists/${listId}/accounts`, token)
				.send({ account_ids: iris.map((iri) => accountIds.get(iri)!) });

		// フォロー関係は Store が更新する射影から読む (→ ADR-0082) ので、Store 経由で Follow を保存する。
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

		const getTimeline = async (path: string) => {
			const res = await mastodonReq.get(path, 'me-token');
			expect(res.status).toBe(200);
			return (res.body as { uri: string }[]).map((status) => status.uri);
		};

		beforeEach(async () => {
			vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
			me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
			await createLocalActor('alice', { uid: UID_ALICE, id: '2' });
			await addAccessToken('me-token', 'read write', UID_ME);
			await addAccessToken('alice-token', 'read write', UID_ALICE);
			await addAccessToken('me-read-token', 'read:lists', UID_ME);
			for (const [id, name] of [
				[REMOTE_A, 'alice'],
				[REMOTE_B, 'bob'],
				[REMOTE_C, 'carol'],
			] as const) {
				await apex.store.saveObject({
					id,
					type: 'Person',
					preferredUsername: name,
					inbox: `${id}/inbox`,
					outbox: `${id}/outbox`,
				} as unknown as APObject);
			}
			accountIds = await resolveAccountIds([me.id, REMOTE_A, REMOTE_B, REMOTE_C]);
			n = 0;
			if (mode === 'feed') {
				await enableTimelineFeeds(me.id);
			}
		});

		afterEach(async () => {
			vi.restoreAllMocks();
			await resetFirestore();
		});

		describe('lists CRUD', () => {
			test('creates, shows, updates and deletes a list', async () => {
				const created = await createList({ title: 'TSG' });
				expect(created).toEqual({
					id: expect.stringMatching(/^\d{20}$/),
					title: 'TSG',
					replies_policy: 'list',
					exclusive: false,
				});

				const second = await createList({
					title: 'Work',
					replies_policy: 'none',
					exclusive: 'true',
				});
				expect(second).toMatchObject({ replies_policy: 'none', exclusive: true });

				const index = await mastodonReq.get('/api/v1/lists', 'me-read-token');
				expect(index.status).toBe(200);
				expect((index.body as ListBody[]).map((list) => list.title)).toEqual(['TSG', 'Work']);

				const shown = await mastodonReq.get(`/api/v1/lists/${created.id}`, 'me-token');
				expect(shown.body).toEqual(created);

				const updated = await mastodonReq
					.put(`/api/v1/lists/${created.id}`, 'me-token')
					.send({ replies_policy: 'followed', exclusive: true });
				expect(updated.status).toBe(200);
				expect(updated.body).toEqual({ ...created, replies_policy: 'followed', exclusive: true });

				const deleted = await mastodonReq.delete(`/api/v1/lists/${created.id}`, 'me-token');
				expect(deleted.status).toBe(200);
				expect(deleted.body).toEqual({});
				expect((await mastodonReq.get(`/api/v1/lists/${created.id}`, 'me-token')).status).toBe(404);
			});

			test('rejects a blank title and an unknown replies_policy with 422', async () => {
				const blank = await mastodonReq.post('/api/v1/lists', 'me-token').send({ title: ' ' });
				expect(blank.status).toBe(422);
				expect(blank.body).toEqual({ error: "Validation failed: Title can't be blank" });

				const policy = await mastodonReq
					.post('/api/v1/lists', 'me-token')
					.send({ title: 'x', replies_policy: 'some' });
				expect(policy.status).toBe(422);
				expect(policy.body).toEqual({ error: "'some' is not a valid replies_policy" });

				const list = await createList({ title: 'x' });
				const update = await mastodonReq
					.put(`/api/v1/lists/${list.id}`, 'me-token')
					.send({ title: '' });
				expect(update.status).toBe(422);
			});

			test("does not expose another user's list", async () => {
				const list = await createList({ title: 'mine' });
				expect((await mastodonReq.get(`/api/v1/lists/${list.id}`, 'alice-token')).status).toBe(404);
				expect((await mastodonReq.delete(`/api/v1/lists/${list.id}`, 'alice-token')).status).toBe(
					404,
				);
				const index = await mastodonReq.get('/api/v1/lists', 'alice-token');
				expect(index.body).toEqual([]);
				expect((await mastodonReq.get('/api/v1/lists/not-an-id', 'me-token')).status).toBe(404);
			});

			test('requires write:lists to create a list', async () => {
				const res = await mastodonReq.post('/api/v1/lists', 'me-read-token').send({ title: 'x' });
				expect(res.status).toBe(403);
			});
		});

		describe('list accounts', () => {
			test('adds followed accounts and the owner, and rejects others', async () => {
				await follow(REMOTE_A);
				await follow(REMOTE_B, false);
				const list = await createList({ title: 'TSG' });

				expect((await addAccounts(list.id, [REMOTE_A, REMOTE_B, me.id])).status).toBe(200);

				const notFollowing = await addAccounts(list.id, [REMOTE_C]);
				expect(notFollowing.status).toBe(422);

				const duplicate = await addAccounts(list.id, [REMOTE_A]);
				expect(duplicate.status).toBe(422);

				const unknown = await mastodonReq
					.post(`/api/v1/lists/${list.id}/accounts`, 'me-token')
					.send({ account_ids: ['99999999999999999999'] });
				expect(unknown.status).toBe(404);

				const accounts = await mastodonReq.get(`/api/v1/lists/${list.id}/accounts`, 'me-token');
				expect(accounts.status).toBe(200);
				expect((accounts.body as { id: string }[]).map((account) => account.id).sort()).toEqual(
					[REMOTE_A, REMOTE_B, me.id].map((iri) => accountIds.get(iri)!).sort(),
				);

				const containing = await mastodonReq.get(
					`/api/v1/accounts/${accountIds.get(REMOTE_A)}/lists`,
					'me-token',
				);
				expect((containing.body as ListBody[]).map((entry) => entry.id)).toEqual([list.id]);
				const notContaining = await mastodonReq.get(
					`/api/v1/accounts/${accountIds.get(REMOTE_C)}/lists`,
					'me-token',
				);
				expect(notContaining.body).toEqual([]);

				const removed = await mastodonReq
					.delete(`/api/v1/lists/${list.id}/accounts`, 'me-token')
					.query({ 'account_ids[]': accountIds.get(REMOTE_A) });
				expect(removed.status).toBe(200);
				const after = await mastodonReq.get(`/api/v1/lists/${list.id}/accounts`, 'me-token');
				expect((after.body as { id: string }[]).map((account) => account.id).sort()).toEqual(
					[REMOTE_B, me.id].map((iri) => accountIds.get(iri)!).sort(),
				);
			});

			test('pages accounts by account ID in descending order, including the local owner', async () => {
				await follow(REMOTE_A);
				await follow(REMOTE_B);
				const list = await createList({ title: 'TSG' });
				await addAccounts(list.id, [me.id, REMOTE_A, REMOTE_B]);

				const expected = [REMOTE_A, REMOTE_B]
					.map((iri) => accountIds.get(iri)!)
					.sort()
					.reverse()
					.concat(accountIds.get(me.id)!);

				const seen: string[] = [];
				let path: string | undefined = `/api/v1/lists/${list.id}/accounts?limit=1`;
				while (path !== undefined && seen.length < 10) {
					const res = await mastodonReq.get(path, 'me-token');
					expect(res.status).toBe(200);
					seen.push(...(res.body as { id: string }[]).map((account) => account.id));
					path = getLinkPath(res.headers.link as string | undefined, 'next');
				}
				expect(seen).toEqual(expected);

				const all = await mastodonReq.get(`/api/v1/lists/${list.id}/accounts?limit=0`, 'me-token');
				expect((all.body as { id: string }[]).map((account) => account.id)).toEqual(expected);
				expect(all.headers.link).toBeUndefined();
			});
		});

		describe('GET /api/v1/timelines/list/:list_id', () => {
			test('shows posts of followed members only', async () => {
				await follow(REMOTE_A);
				await follow(REMOTE_B);
				const list = await createList({ title: 'TSG' });
				await addAccounts(list.id, [REMOTE_A, me.id]);

				const a1 = await saveNote(REMOTE_A);
				await saveNote(REMOTE_B);
				const mine = await saveNote(me.id);

				expect(await getTimeline(`/api/v1/timelines/list/${list.id}`)).toEqual([mine, a1]);

				// フォローを外した相手は、メンバーのままでもタイムラインに出さない (→ ADR-0134 決定2)
				await apex.store.removeActivity(
					{ id: `${me.id}/follows/${encodeURIComponent(REMOTE_A)}` } as APObject,
					me.id,
				);
				expect(await getTimeline(`/api/v1/timelines/list/${list.id}`)).toEqual([mine]);
			});

			test('pages with Link headers like the home timeline', async () => {
				await follow(REMOTE_A);
				const list = await createList({ title: 'TSG' });
				await addAccounts(list.id, [REMOTE_A]);
				const notes = [
					await saveNote(REMOTE_A),
					await saveNote(REMOTE_A),
					await saveNote(REMOTE_A),
				];

				const first = await mastodonReq.get(
					`/api/v1/timelines/list/${list.id}?limit=2`,
					'me-token',
				);
				expect((first.body as { uri: string }[]).map((status) => status.uri)).toEqual([
					notes[2],
					notes[1],
				]);
				const next = getLinkPath(first.headers.link as string | undefined, 'next');
				expect(next).toBeDefined();
				expect(await getTimeline(next!)).toEqual([notes[0]]);
			});

			test('filters replies by replies_policy', async () => {
				await follow(REMOTE_A);
				await follow(REMOTE_B);
				const parentB = await saveNote(REMOTE_B);
				const parentC = await saveNote(REMOTE_C);
				const parentMine = await saveNote(me.id);
				const parentA = await saveNote(REMOTE_A);

				const toB = await saveNote(REMOTE_A, { inReplyTo: parentB });
				const toC = await saveNote(REMOTE_A, { inReplyTo: parentC });
				const toMe = await saveNote(REMOTE_A, { inReplyTo: parentMine });
				const self = await saveNote(REMOTE_A, { inReplyTo: parentA });
				await saveNote(REMOTE_A, { inReplyTo: 'https://remote.example/u/unknown/notes/1' });

				const timelineOf = async (repliesPolicy: string) => {
					const list = await createList({ title: repliesPolicy, replies_policy: repliesPolicy });
					await addAccounts(list.id, [REMOTE_A]);
					return getTimeline(`/api/v1/timelines/list/${list.id}`);
				};

				// followed: フォロー中の B への返信は出し、フォローしていない C への返信は出さない
				expect(await timelineOf('followed')).toEqual([self, toMe, toB, parentA]);
				// list: メンバー (A) でない B への返信は出さない
				expect(await timelineOf('list')).toEqual([self, toMe, parentA]);
				expect(await timelineOf('none')).toEqual([self, toMe, parentA]);
				expect(toC).toBeDefined();
			});

			test('returns 404 for an unknown list', async () => {
				const res = await mastodonReq.get(
					'/api/v1/timelines/list/00000000000000000001',
					'me-token',
				);
				expect(res.status).toBe(404);
			});
		});

		describe('exclusive lists', () => {
			test('removes members of exclusive lists from the home timeline', async () => {
				await follow(REMOTE_A);
				await follow(REMOTE_B);
				const a1 = await saveNote(REMOTE_A);
				const b1 = await saveNote(REMOTE_B);
				const mine = await saveNote(me.id);

				const list = await createList({ title: 'TSG' });
				await addAccounts(list.id, [REMOTE_A, me.id]);
				expect(await getTimeline('/api/v1/timelines/home')).toEqual([mine, b1, a1]);

				await mastodonReq.put(`/api/v1/lists/${list.id}`, 'me-token').send({ exclusive: true });
				// 自分の投稿は exclusive なリストに入っていてもホームから消さない
				expect(await getTimeline('/api/v1/timelines/home')).toEqual([mine, b1]);
				expect(await getTimeline(`/api/v1/timelines/list/${list.id}`)).toEqual([mine, a1]);
			});
		});
	},
);
