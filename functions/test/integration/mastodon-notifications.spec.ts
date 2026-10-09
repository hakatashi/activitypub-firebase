import firebase from 'firebase-admin';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { buildMastodonId } from '../../src/mastodonId.js';
import { Markers, Notifications } from '../../src/schema.js';
import type { LocalActor } from '../helpers/index.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const TOKEN_READ = 'token-notifications-read';
const TOKEN_WRITE = 'token-notifications-write';
const TOKEN_WRONG = 'token-wrong-scope';

const REMOTE_ALICE = 'https://remote.example/u/alice';
const REMOTE_BOB = 'https://remote.example/u/bob';

describe('Mastodon notifications API (Issue #222, ADR-0089)', () => {
	let me: LocalActor;
	let myActorKey: ReturnType<typeof escapeFirestoreKey>;

	beforeEach(async () => {
		me = await createLocalActor('hakatashi', {
			uid: UID_ME,
			id: '1',
		});
		myActorKey = escapeFirestoreKey(me.id as string);

		await addAccessToken(TOKEN_READ, 'read:notifications read:statuses', UID_ME);
		await addAccessToken(TOKEN_WRITE, 'write:notifications write:statuses', UID_ME);
		await addAccessToken(TOKEN_WRONG, 'read:statuses write:statuses', UID_ME);

		// リモートアクターの保存
		for (const [id, name] of [
			[REMOTE_ALICE, 'alice'],
			[REMOTE_BOB, 'bob'],
		] as const) {
			await apex.store.saveObject({
				id,
				type: 'Person',
				preferredUsername: name,
				inbox: `${id}/inbox`,
				outbox: `${id}/outbox`,
			} as unknown as APObject);
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	// oxlint-disable-next-line max-params
	const saveNote = async (
		id: string,
		attributedTo: string,
		content: string,
		extra: Record<string, unknown> = {},
	) => {
		await apex.store.saveObject({
			id,
			type: 'Note',
			attributedTo,
			content,
			published: '2026-01-01T00:00:00.000Z',
			to: ['https://www.w3.org/ns/activitystreams#Public'],
			cc: [],
			...extra,
		} as unknown as APObject);
	};

	const saveNotification = async ({
		id,
		type,
		activityIri,
		accountIri,
		statusIri,
		timestampMs,
	}: {
		id: string;
		type: 'mention' | 'favourite' | 'reblog' | 'follow';
		activityIri: string;
		accountIri: string;
		statusIri: string | null;
		timestampMs: number;
	}) => {
		await Notifications(myActorKey)
			.doc(escapeFirestoreKey(activityIri))
			.set({
				id,
				type,
				activityIri,
				accountIri,
				statusIri,
				createdAt: firebase.firestore.Timestamp.fromMillis(timestampMs),
			});
	};

	describe('Authentication & Scopes', () => {
		test('GET /api/v1/notifications requires read:notifications', async () => {
			const unauth = await request(mastodon).get('/api/v1/notifications');
			expect(unauth.status).toBe(401);

			const forbidden = await request(mastodon)
				.get('/api/v1/notifications')
				.set('Authorization', `Bearer ${TOKEN_WRONG}`);
			expect(forbidden.status).toBe(403);

			const ok = await request(mastodon)
				.get('/api/v1/notifications')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(ok.status).toBe(200);
		});

		test('POST /api/v1/notifications/clear requires write:notifications', async () => {
			const unauth = await request(mastodon).post('/api/v1/notifications/clear');
			expect(unauth.status).toBe(401);

			const forbidden = await request(mastodon)
				.post('/api/v1/notifications/clear')
				.set('Authorization', `Bearer ${TOKEN_WRONG}`);
			expect(forbidden.status).toBe(403);

			const ok = await request(mastodon)
				.post('/api/v1/notifications/clear')
				.set('Authorization', `Bearer ${TOKEN_WRITE}`);
			expect(ok.status).toBe(200);
		});

		test('POST /api/v1/notifications/:id/dismiss requires write:notifications', async () => {
			const unauth = await request(mastodon).post('/api/v1/notifications/123/dismiss');
			expect(unauth.status).toBe(401);

			const forbidden = await request(mastodon)
				.post('/api/v1/notifications/123/dismiss')
				.set('Authorization', `Bearer ${TOKEN_WRONG}`);
			expect(forbidden.status).toBe(403);
		});

		test('GET /api/v1/notifications/unread_count requires read:notifications', async () => {
			const unauth = await request(mastodon).get('/api/v1/notifications/unread_count');
			expect(unauth.status).toBe(401);

			const forbidden = await request(mastodon)
				.get('/api/v1/notifications/unread_count')
				.set('Authorization', `Bearer ${TOKEN_WRONG}`);
			expect(forbidden.status).toBe(403);

			const ok = await request(mastodon)
				.get('/api/v1/notifications/unread_count')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(ok.status).toBe(200);
		});
	});

	describe('GET /api/v1/notifications', () => {
		test('returns assembled notifications in descending order of id', async () => {
			const note1 = 'https://remote.example/notes/1';
			const note2 = `${me.id}/notes/2`;
			await saveNote(note1, REMOTE_ALICE, '<p>Hello @hakatashi</p>');
			await saveNote(note2, me.id as string, '<p>My post</p>');

			const id1 = buildMastodonId(1_700_000_001_000, 1);
			const id2 = buildMastodonId(1_700_000_002_000, 2);
			const id3 = buildMastodonId(1_700_000_003_000, 3);

			await saveNotification({
				id: id1,
				type: 'follow',
				activityIri: 'https://remote.example/activities/follow/1',
				accountIri: REMOTE_ALICE,
				statusIri: null,
				timestampMs: 1_700_000_001_000,
			});
			await saveNotification({
				id: id2,
				type: 'mention',
				activityIri: 'https://remote.example/activities/create/2',
				accountIri: REMOTE_ALICE,
				statusIri: note1,
				timestampMs: 1_700_000_002_000,
			});
			await saveNotification({
				id: id3,
				type: 'favourite',
				activityIri: 'https://remote.example/activities/like/3',
				accountIri: REMOTE_BOB,
				statusIri: note2,
				timestampMs: 1_700_000_003_000,
			});

			const res = await request(mastodon)
				.get('/api/v1/notifications')
				.set('Authorization', `Bearer ${TOKEN_READ}`);

			expect(res.status).toBe(200);
			expect(res.body).toHaveLength(3);
			// 新しい順: id3, id2, id1
			expect(res.body[0].id).toBe(id3);
			expect(res.body[0].type).toBe('favourite');
			expect(res.body[0].account.username).toBe('bob');
			expect(res.body[0].status.id).toBeDefined();
			expect(res.body[0].group_key).toBe(`ungrouped-${id3}`);

			expect(res.body[1].id).toBe(id2);
			expect(res.body[1].type).toBe('mention');
			expect(res.body[1].account.username).toBe('alice');
			expect(res.body[1].status.content).toContain('Hello @hakatashi');

			expect(res.body[2].id).toBe(id1);
			expect(res.body[2].type).toBe('follow');
			expect(res.body[2].account.username).toBe('alice');
			expect(res.body[2].status).toBeUndefined();

			// Link header
			expect(res.headers.link).toBeDefined();
			expect(res.headers.link).toContain(`max_id=${id1}`);
			expect(res.headers.link).toContain(`min_id=${id3}`);
		});

		test('filters by types[] and exclude_types[]', async () => {
			const note1 = 'https://remote.example/notes/1';
			const note2 = `${me.id}/notes/2`;
			await saveNote(note1, REMOTE_ALICE, 'Post 1');
			await saveNote(note2, me.id as string, 'Post 2');

			const id1 = buildMastodonId(1_700_000_001_000, 1);
			const id2 = buildMastodonId(1_700_000_002_000, 2);

			await saveNotification({
				id: id1,
				type: 'follow',
				activityIri: 'https://remote.example/activities/1',
				accountIri: REMOTE_ALICE,
				statusIri: null,
				timestampMs: 1_700_000_001_000,
			});
			await saveNotification({
				id: id2,
				type: 'mention',
				activityIri: 'https://remote.example/activities/2',
				accountIri: REMOTE_ALICE,
				statusIri: note1,
				timestampMs: 1_700_000_002_000,
			});

			const resTypes = await request(mastodon)
				.get('/api/v1/notifications?types[]=mention')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resTypes.status).toBe(200);
			expect(resTypes.body).toHaveLength(1);
			expect(resTypes.body[0].type).toBe('mention');

			const resExclude = await request(mastodon)
				.get('/api/v1/notifications?exclude_types[]=mention')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resExclude.status).toBe(200);
			expect(resExclude.body).toHaveLength(1);
			expect(resExclude.body[0].type).toBe('follow');
		});

		test('filters by account_id', async () => {
			const note1 = 'https://remote.example/notes/1';
			await saveNote(note1, REMOTE_ALICE, 'Post 1');

			const id1 = buildMastodonId(1_700_000_001_000, 1);
			const id2 = buildMastodonId(1_700_000_002_000, 2);

			await saveNotification({
				id: id1,
				type: 'follow',
				activityIri: 'https://remote.example/activities/1',
				accountIri: REMOTE_ALICE,
				statusIri: null,
				timestampMs: 1_700_000_001_000,
			});
			await saveNotification({
				id: id2,
				type: 'follow',
				activityIri: 'https://remote.example/activities/2',
				accountIri: REMOTE_BOB,
				statusIri: null,
				timestampMs: 1_700_000_002_000,
			});

			// Alice のアカウント ID を取得
			const allRes = await request(mastodon)
				.get('/api/v1/notifications')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			const aliceAccount = allRes.body.find(
				(n: { account: { username: string } }) => n.account.username === 'alice',
			).account;

			const filteredRes = await request(mastodon)
				.get(`/api/v1/notifications?account_id=${aliceAccount.id}`)
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(filteredRes.status).toBe(200);
			expect(filteredRes.body).toHaveLength(1);
			expect(filteredRes.body[0].account.username).toBe('alice');
		});

		test('safely skips broken notifications without throwing 500 (ADR-0089)', async () => {
			const validNote = 'https://remote.example/notes/valid';
			const tombstoneNote = 'https://remote.example/notes/tombstone';
			await saveNote(validNote, REMOTE_ALICE, 'Valid');
			await apex.store.saveObject({
				id: tombstoneNote,
				type: 'Tombstone',
			} as unknown as APObject);

			const idValid = buildMastodonId(1_700_000_001_000, 1);
			const idMissingActor = buildMastodonId(1_700_000_002_000, 2);
			const idTombstone = buildMastodonId(1_700_000_003_000, 3);
			const idMissingNote = buildMastodonId(1_700_000_004_000, 4);

			// 1. 有効な通知
			await saveNotification({
				id: idValid,
				type: 'mention',
				activityIri: 'https://remote.example/activities/valid',
				accountIri: REMOTE_ALICE,
				statusIri: validNote,
				timestampMs: 1_700_000_001_000,
			});

			// 2. 存在しない actor
			await saveNotification({
				id: idMissingActor,
				type: 'follow',
				activityIri: 'https://remote.example/activities/missing-actor',
				accountIri: 'https://remote.example/u/ghost',
				statusIri: null,
				timestampMs: 1_700_000_002_000,
			});

			// 3. Tombstone の Note
			await saveNotification({
				id: idTombstone,
				type: 'mention',
				activityIri: 'https://remote.example/activities/tombstone',
				accountIri: REMOTE_ALICE,
				statusIri: tombstoneNote,
				timestampMs: 1_700_000_003_000,
			});

			// 4. 存在しない Note
			await saveNotification({
				id: idMissingNote,
				type: 'favourite',
				activityIri: 'https://remote.example/activities/missing-note',
				accountIri: REMOTE_ALICE,
				statusIri: 'https://remote.example/notes/ghost',
				timestampMs: 1_700_000_004_000,
			});

			const res = await request(mastodon)
				.get('/api/v1/notifications')
				.set('Authorization', `Bearer ${TOKEN_READ}`);

			expect(res.status).toBe(200);
			// 破損通知 3 件は除外され、有効な 1 件のみ返る
			expect(res.body).toHaveLength(1);
			expect(res.body[0].id).toBe(idValid);

			// Link ヘッダには読んだ範囲の端 (newest: idMissingNote, oldest: idValid) が反映される (ADR-0089)
			expect(res.headers.link).toContain(`max_id=${idValid}`);
			expect(res.headers.link).toContain(`min_id=${idMissingNote}`);
		});

		test('paginates correctly using max_id, since_id, min_id', async () => {
			const ids: string[] = [];
			for (let i = 1; i <= 5; i++) {
				const id = buildMastodonId(1_700_000_000_000 + i * 1000, i);
				ids.push(id);
				await saveNotification({
					id,
					type: 'follow',
					activityIri: `https://remote.example/activities/follow/${i}`,
					accountIri: REMOTE_ALICE,
					statusIri: null,
					timestampMs: 1_700_000_000_000 + i * 1000,
				});
			}

			// limit=2
			const resPage1 = await request(mastodon)
				.get('/api/v1/notifications?limit=2')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resPage1.body.map((n: { id: string }) => n.id)).toEqual([ids[4], ids[3]]);

			// max_id=ids[3] -> ids[2], ids[1]
			const resPage2 = await request(mastodon)
				.get(`/api/v1/notifications?limit=2&max_id=${ids[3]}`)
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resPage2.body.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[1]]);

			// min_id=ids[1] -> ids[3], ids[2] (adjacent to cursor, newest first)
			const resMin = await request(mastodon)
				.get(`/api/v1/notifications?limit=2&min_id=${ids[1]}`)
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resMin.body.map((n: { id: string }) => n.id)).toEqual([ids[3], ids[2]]);
		});

		test('Link header cursors do not skip notifications beyond the returned page (ADR-0108)', async () => {
			const ids: string[] = [];
			for (let i = 1; i <= 7; i++) {
				const id = buildMastodonId(1_700_000_000_000 + i * 1000, i);
				ids.push(id);
				await saveNotification({
					id,
					type: 'follow',
					activityIri: `https://remote.example/activities/follow/${i}`,
					accountIri: REMOTE_ALICE,
					statusIri: null,
					timestampMs: 1_700_000_000_000 + i * 1000,
				});
			}

			const seen: string[] = [];
			let url: string | undefined = '/api/v1/notifications?limit=2';
			for (let i = 0; i < 10 && url !== undefined; i++) {
				const res: request.Response = await request(mastodon)
					.get(url)
					.set('Authorization', `Bearer ${TOKEN_READ}`);
				expect(res.status).toBe(200);
				if (res.body.length === 0) {
					break;
				}
				seen.push(...res.body.map((n: { id: string }) => n.id));
				const next: string | undefined = /<(?<url>[^>]+)>; rel="next"/.exec(res.headers.link ?? '')
					?.groups?.url;
				url = next === undefined ? undefined : new URL(next).pathname + new URL(next).search;
			}

			expect(seen).toEqual([...ids].reverse());
		});
	});

	describe('GET /api/v1/notifications/:id', () => {
		test('returns single notification', async () => {
			const id = buildMastodonId(1_700_000_001_000, 1);
			await saveNotification({
				id,
				type: 'follow',
				activityIri: 'https://remote.example/activities/follow/1',
				accountIri: REMOTE_ALICE,
				statusIri: null,
				timestampMs: 1_700_000_001_000,
			});

			const res = await request(mastodon)
				.get(`/api/v1/notifications/${id}`)
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(res.status).toBe(200);
			expect(res.body.id).toBe(id);
			expect(res.body.type).toBe('follow');
			expect(res.body.account.username).toBe('alice');
		});

		test('returns 404 for non-existent notification', async () => {
			const notFoundId = buildMastodonId(1_700_000_099_000, 1);
			const res = await request(mastodon)
				.get(`/api/v1/notifications/${notFoundId}`)
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(res.status).toBe(404);
			expect(res.body.error).toBe('Record not found');
		});

		test('returns 404 for un-assemblable notification', async () => {
			const id = buildMastodonId(1_700_000_001_000, 1);
			await saveNotification({
				id,
				type: 'follow',
				activityIri: 'https://remote.example/activities/follow/1',
				accountIri: 'https://remote.example/u/ghost',
				statusIri: null,
				timestampMs: 1_700_000_001_000,
			});

			const res = await request(mastodon)
				.get(`/api/v1/notifications/${id}`)
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(res.status).toBe(404);
		});
	});

	describe('POST /api/v1/notifications/:id/dismiss', () => {
		test('dismisses single notification', async () => {
			const id = buildMastodonId(1_700_000_001_000, 1);
			await saveNotification({
				id,
				type: 'follow',
				activityIri: 'https://remote.example/activities/follow/1',
				accountIri: REMOTE_ALICE,
				statusIri: null,
				timestampMs: 1_700_000_001_000,
			});

			const res = await request(mastodon)
				.post(`/api/v1/notifications/${id}/dismiss`)
				.set('Authorization', `Bearer ${TOKEN_WRITE}`);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({});

			const checkRes = await request(mastodon)
				.get(`/api/v1/notifications/${id}`)
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(checkRes.status).toBe(404);
		});

		test('returns 404 for non-existent notification', async () => {
			const id = buildMastodonId(1_700_000_099_000, 1);
			const res = await request(mastodon)
				.post(`/api/v1/notifications/${id}/dismiss`)
				.set('Authorization', `Bearer ${TOKEN_WRITE}`);
			expect(res.status).toBe(404);
		});
	});

	describe('POST /api/v1/notifications/clear', () => {
		test('clears all notifications', async () => {
			for (let i = 1; i <= 3; i++) {
				const id = buildMastodonId(1_700_000_000_000 + i * 1000, i);
				await saveNotification({
					id,
					type: 'follow',
					activityIri: `https://remote.example/activities/follow/${i}`,
					accountIri: REMOTE_ALICE,
					statusIri: null,
					timestampMs: 1_700_000_000_000 + i * 1000,
				});
			}

			const res = await request(mastodon)
				.post('/api/v1/notifications/clear')
				.set('Authorization', `Bearer ${TOKEN_WRITE}`);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({});

			const checkRes = await request(mastodon)
				.get('/api/v1/notifications')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(checkRes.body).toHaveLength(0);
		});
	});

	describe('GET /api/v1/notifications/unread_count', () => {
		test('counts unread notifications based on markers last_read_id (ADR-0089)', async () => {
			const ids: string[] = [];
			for (let i = 1; i <= 5; i++) {
				const id = buildMastodonId(1_700_000_000_000 + i * 1000, i);
				ids.push(id);
				await saveNotification({
					id,
					type: i % 2 === 0 ? 'mention' : 'follow',
					activityIri: `https://remote.example/activities/${i}`,
					accountIri: REMOTE_ALICE,
					statusIri: null,
					timestampMs: 1_700_000_000_000 + i * 1000,
				});
			}

			// マーカーなし -> 5
			const resNoMarker = await request(mastodon)
				.get('/api/v1/notifications/unread_count')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resNoMarker.status).toBe(200);
			expect(resNoMarker.body).toEqual({ count: 5 });

			// マーカー設定 (3番目まで既読) -> 残り 2件 (ids[3], ids[4])
			await Markers.doc(escapeFirestoreKey(`${me.id}_notifications`)).set({
				actorId: me.id as string,
				timeline: 'notifications',
				lastReadId: ids[2]!,
				version: 1,
				updatedAt: firebase.firestore.Timestamp.now(),
			});

			const resWithMarker = await request(mastodon)
				.get('/api/v1/notifications/unread_count')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resWithMarker.status).toBe(200);
			expect(resWithMarker.body).toEqual({ count: 2 });

			// フィルタ適用: exclude_types[]=mention -> 残り ids[4] (5番目, follow) のみ 1件
			const resExclude = await request(mastodon)
				.get('/api/v1/notifications/unread_count?exclude_types[]=mention')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resExclude.status).toBe(200);
			expect(resExclude.body).toEqual({ count: 1 });

			// limit=1 -> 1件で capped
			const resLimit = await request(mastodon)
				.get('/api/v1/notifications/unread_count?limit=1')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(resLimit.status).toBe(200);
			expect(resLimit.body).toEqual({ count: 1 });
		});
	});

	describe('Phanpy stubs (ADR-0067, ADR-0089)', () => {
		test('GET /api/v2/notifications/policy returns default policy', async () => {
			const res = await request(mastodon)
				.get('/api/v2/notifications/policy')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(res.status).toBe(200);
			expect(res.body.for_not_following).toBe('accept');
			expect(res.body.summary.pending_requests_count).toBe(0);
		});

		test('GET /api/v1/notifications/requests returns empty array', async () => {
			const res = await request(mastodon)
				.get('/api/v1/notifications/requests')
				.set('Authorization', `Bearer ${TOKEN_READ}`);
			expect(res.status).toBe(200);
			expect(res.body).toEqual([]);
		});
	});
});
