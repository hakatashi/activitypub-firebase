import type { APObject } from '../../src/apex/index.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { plainTextToHtml, publishNote } from '../../src/notes.js';
import { Streams, UserInfos } from '../../src/schema.js';
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

describe('GET / DELETE /api/v1/statuses/:id and /context (Issue #61)', () => {
	let me: LocalActor;
	let alice: LocalActor;

	const addToken = (token: string, scope: string, uid = UID_ME) =>
		addAccessToken(token, scope, uid);

	const getStatus = (id: string, token?: string) =>
		mastodonReq.get(`/api/v1/statuses/${id}`, token);

	const deleteStatus = (id: string, token?: string) =>
		mastodonReq.delete(`/api/v1/statuses/${id}`, token);

	const getContext = (id: string, token?: string) =>
		mastodonReq.get(`/api/v1/statuses/${id}/context`, token);

	const postStatusAction = (id: string, action: string, token?: string) =>
		mastodonReq.post(`/api/v1/statuses/${id}/${action}`, token);

	beforeEach(async () => {
		await resetFirestore();
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);

		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
		alice = await createLocalActor('alice', { uid: UID_ALICE, id: '2' });

		await apex.store.saveObject({
			id: REMOTE_BOB,
			type: 'Person',
			preferredUsername: 'bob',
			inbox: `${REMOTE_BOB}/inbox`,
			outbox: `${REMOTE_BOB}/outbox`,
		} as unknown as APObject);

		await addToken('me-token', 'read write follow', UID_ME);
		await addToken('me-statuses-token', 'write:statuses', UID_ME);
		await addToken('me-favourites-token', 'write:favourites', UID_ME);
		await addToken('me-bookmarks-token', 'write:bookmarks', UID_ME);
		await addToken('me-accounts-token', 'write:accounts', UID_ME);
		await addToken('me-read-token', 'read', UID_ME);
		await addToken('alice-token', 'read write follow', UID_ALICE);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('GET /api/v1/statuses/:id', () => {
		test('returns a public status by Mastodon ID', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Test status'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id);
			expect(mastodonId).toBeDefined();

			const res = await getStatus(mastodonId!);
			expect(res.status).toBe(200);
			expect(res.body.id).toBe(mastodonId);
			expect(res.body.content).toBe('<p>Test status</p>');
			expect(res.body.visibility).toBe('public');
			expect(res.body.account.username).toBe('hakatashi');
		});

		test('returns 404 for nonexistent status ID', async () => {
			const res = await getStatus('99999999999999999999');
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ error: 'Record not found' });
		});

		test('returns 404 when object is a Tombstone', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('To be deleted'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id)!;

			const tombstone = await apex.buildTombstone(note);
			await apex.store.updateObject(tombstone, me.id, true);

			const res = await getStatus(mastodonId);
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ error: 'Record not found' });
		});

		test('hides private status from unauthenticated requests and non-followers', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Private note'),
				visibility: 'private',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id)!;

			// 未認証
			const unauthRes = await getStatus(mastodonId);
			expect(unauthRes.status).toBe(404);
			expect(unauthRes.body).toEqual({ error: 'Record not found' });

			// 他のユーザー (未フォロー)
			const aliceRes = await getStatus(mastodonId, 'alice-token');
			expect(aliceRes.status).toBe(404);
			expect(aliceRes.body).toEqual({ error: 'Record not found' });

			// 投稿者本人
			const meRes = await getStatus(mastodonId, 'me-token');
			expect(meRes.status).toBe(200);
			expect(meRes.body.id).toBe(mastodonId);
			expect(meRes.body.visibility).toBe('private');
		});
	});

	describe('DELETE /api/v1/statuses/:id', () => {
		test('requires authorization and write:statuses scope', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Note to delete'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id)!;

			// 未認証
			const unauthRes = await deleteStatus(mastodonId);
			expect(unauthRes.status).toBe(401);

			// read スコープのみ
			const readOnlyRes = await deleteStatus(mastodonId, 'me-read-token');
			expect(readOnlyRes.status).toBe(403);
		});

		test('returns 404 when trying to delete someone else status', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('My note'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id)!;

			// Alice tries to delete my note
			const res = await deleteStatus(mastodonId, 'alice-token');
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ error: 'Record not found' });
		});

		test('deletes own status, returns deleted status with text, and turns object into Tombstone', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Line 1\n\nLine 2'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id)!;

			const res = await deleteStatus(mastodonId, 'me-statuses-token');
			expect(res.status).toBe(200);
			expect(res.body.id).toBe(mastodonId);
			expect(res.body.content).toBe('<p>Line 1</p><p>Line 2</p>');
			// Mastodon の delete and redraft 用に text が返る
			expect(res.body.text).toBe('Line 1\n\nLine 2');

			// GET では 404 になる
			const getRes = await getStatus(mastodonId);
			expect(getRes.status).toBe(404);

			// DB 内のオブジェクトが Tombstone になっている
			const stored = await apex.store.getObject(note.id);
			expect(stored?.type).toBe('Tombstone');

			// Delete アクティビティが Streams に保存され outbox に積まれた
			const streams = await Streams.where('type', '==', 'Delete').get();
			expect(streams.docs.length).toBe(1);
			const deleteActivity = streams.docs[0]?.data();
			expect(deleteActivity?.actor).toEqual([me.id]);
			expect(deleteActivity?._meta?.collection).toContain(`${me.id}/outbox`);
			expect(JSON.stringify(deleteActivity?.object)).toContain('Tombstone');
		});

		test('enqueues delivery for Delete activity when recipients exist', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Direct reply to bob'),
				visibility: 'direct',
				mentions: [REMOTE_BOB],
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id)!;

			vi.clearAllMocks();
			const res = await deleteStatus(mastodonId, 'me-statuses-token');
			expect(res.status).toBe(200);
			expect(apex.store.deliveryEnqueue).toHaveBeenCalled();
		});

		test('reverts boost when deleting own boost status ID, returning boost status', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Note to boost and delete'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const noteMastodonId = ids.get(note.id)!;

			const boostRes = await request(mastodon)
				.post(`/api/v1/statuses/${noteMastodonId}/reblog`)
				.set('Authorization', 'Bearer me-statuses-token');
			expect(boostRes.status).toBe(200);
			const boostId = boostRes.body.id;
			expect(boostId).not.toBe(noteMastodonId);

			// 自分のブーストの ID に対する DELETE
			const deleteRes = await deleteStatus(boostId, 'me-statuses-token');
			expect(deleteRes.status).toBe(200);
			expect(deleteRes.body.id).toBe(boostId);
			expect(deleteRes.body.reblog.id).toBe(noteMastodonId);

			// ブーストの ID は 404 になる
			const getBoostRes = await getStatus(boostId);
			expect(getBoostRes.status).toBe(404);

			// 元の Note の reblogged は false に戻る
			const getNoteRes = await getStatus(noteMastodonId, 'me-statuses-token');
			expect(getNoteRes.status).toBe(200);
			expect(getNoteRes.body.reblogged).toBe(false);
		});

		test('returns 404 when trying to delete someone else boost', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Note to boost'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const noteMastodonId = ids.get(note.id)!;

			const boostRes = await request(mastodon)
				.post(`/api/v1/statuses/${noteMastodonId}/reblog`)
				.set('Authorization', 'Bearer me-statuses-token');
			const boostId = boostRes.body.id;

			// Alice tries to delete my boost
			const deleteRes = await deleteStatus(boostId, 'alice-token');
			expect(deleteRes.status).toBe(404);
		});
	});

	describe('GET /api/v1/statuses/:id/context', () => {
		test('returns empty ancestors and descendants for a standalone status', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Standalone'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const mastodonId = ids.get(note.id)!;

			const res = await getContext(mastodonId);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ ancestors: [], descendants: [] });
		});

		test('returns empty ancestors and descendants for a boost ID', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Note to boost'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const noteMastodonId = ids.get(note.id)!;

			const boostRes = await request(mastodon)
				.post(`/api/v1/statuses/${noteMastodonId}/reblog`)
				.set('Authorization', 'Bearer me-statuses-token');
			const boostId = boostRes.body.id;

			const res = await getContext(boostId);
			expect(res.status).toBe(200);
			expect(res.body).toEqual({ ancestors: [], descendants: [] });
		});

		test('returns 404 for a boost ID when target note does not exist', async () => {
			const boostId = `${REMOTE_BOB}/announces/ghost-boost`;
			await apex.store.saveActivity({
				id: boostId,
				type: 'Announce',
				actor: REMOTE_BOB,
				object: 'https://remote.example/notes/ghost',
				published: new Date().toISOString(),
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				cc: [],
			} as unknown as APObject);
			const ids = await getMastodonIds([{ iri: boostId, published: new Date().toISOString() }]);
			const mastodonId = ids.get(boostId)!;

			const res = await getContext(mastodonId);
			expect(res.status).toBe(404);
		});

		test('returns 404 for a boost ID when target note is private and viewer cannot view it', async () => {
			const privNote = 'https://remote.example/notes/secret';
			await apex.store.saveObject({
				id: privNote,
				type: 'Note',
				attributedTo: REMOTE_BOB,
				content: 'Secret note',
				published: new Date().toISOString(),
				to: [`${REMOTE_BOB}/followers`],
				cc: [],
			} as unknown as APObject);

			const boostId = `${REMOTE_BOB}/announces/secret-boost`;
			await apex.store.saveActivity({
				id: boostId,
				type: 'Announce',
				actor: REMOTE_BOB,
				object: privNote,
				published: new Date().toISOString(),
				to: ['https://www.w3.org/ns/activitystreams#Public'],
				cc: [],
			} as unknown as APObject);
			const ids = await getMastodonIds([{ iri: boostId, published: new Date().toISOString() }]);
			const mastodonId = ids.get(boostId)!;

			// me does not follow REMOTE_BOB
			const res = await getContext(mastodonId, 'me-token');
			expect(res.status).toBe(404);
		});

		test('returns ancestors in chronological order (root to direct parent)', async () => {
			// Grandparent -> Parent -> Child
			const { object: grandparent } = await publishNote(me, {
				content: plainTextToHtml('Grandparent note'),
				visibility: 'public',
			});
			const { object: parent } = await publishNote(me, {
				content: plainTextToHtml('Parent note'),
				visibility: 'public',
				inReplyTo: grandparent.id,
			});
			const { object: child } = await publishNote(me, {
				content: plainTextToHtml('Child note'),
				visibility: 'public',
				inReplyTo: parent.id,
			});

			const ids = await getMastodonIds([
				{ iri: grandparent.id, published: grandparent.published },
				{ iri: parent.id, published: parent.published },
				{ iri: child.id, published: child.published },
			]);
			const childId = ids.get(child.id)!;
			const parentId = ids.get(parent.id)!;
			const grandparentId = ids.get(grandparent.id)!;

			const res = await getContext(childId);
			expect(res.status).toBe(200);
			expect(res.body.ancestors.map((s: { id: string }) => s.id)).toEqual([
				grandparentId,
				parentId,
			]);
			expect(res.body.descendants).toEqual([]);
		});

		test('returns descendants in DFS thread order', async () => {
			// Root
			//   ├── Reply 1
			//   │     └── Reply 1-1
			//   └── Reply 2
			const { object: root } = await publishNote(me, {
				content: plainTextToHtml('Root'),
				visibility: 'public',
			});
			const { object: reply1 } = await publishNote(me, {
				content: plainTextToHtml('Reply 1'),
				visibility: 'public',
				inReplyTo: root.id,
			});
			const { object: reply11 } = await publishNote(me, {
				content: plainTextToHtml('Reply 1-1'),
				visibility: 'public',
				inReplyTo: reply1.id,
			});
			const { object: reply2 } = await publishNote(me, {
				content: plainTextToHtml('Reply 2'),
				visibility: 'public',
				inReplyTo: root.id,
			});

			const ids = await getMastodonIds([
				{ iri: root.id, published: root.published },
				{ iri: reply1.id, published: reply1.published },
				{ iri: reply11.id, published: reply11.published },
				{ iri: reply2.id, published: reply2.published },
			]);
			const rootId = ids.get(root.id)!;
			const reply1Id = ids.get(reply1.id)!;
			const reply11Id = ids.get(reply11.id)!;
			const reply2Id = ids.get(reply2.id)!;

			const res = await getContext(rootId);
			expect(res.status).toBe(200);
			expect(res.body.ancestors).toEqual([]);
			expect(res.body.descendants.map((s: { id: string }) => s.id)).toEqual([
				reply1Id,
				reply11Id,
				reply2Id,
			]);
		});

		test('handles circular inReplyTo without infinite loop', async () => {
			// Note A <-> Note B
			const idA = 'https://example.com/activitypub/o/cycle-a';
			const idB = 'https://example.com/activitypub/o/cycle-b';

			await apex.store.saveObject({
				id: idA,
				type: 'Note',
				attributedTo: me.id,
				to: ['as:Public'],
				content: '<p>Cycle A</p>',
				published: new Date().toISOString(),
				inReplyTo: idB,
			} as unknown as APObject);

			await apex.store.saveObject({
				id: idB,
				type: 'Note',
				attributedTo: me.id,
				to: ['as:Public'],
				content: '<p>Cycle B</p>',
				published: new Date().toISOString(),
				inReplyTo: idA,
			} as unknown as APObject);

			const ids = await getMastodonIds([
				{ iri: idA, published: undefined },
				{ iri: idB, published: undefined },
			]);
			const mastodonIdA = ids.get(idA)!;

			// Should terminate without timing out
			const res = await getContext(mastodonIdA);
			expect(res.status).toBe(200);
			expect(res.body.ancestors.length).toBe(1);
			expect(res.body.ancestors[0].id).toBe(ids.get(idB));
		});

		test('stops at missing remote parent without making network request', async () => {
			const remoteParentIri = 'https://remote.example/notes/missing-parent';
			const { object: child } = await publishNote(me, {
				content: plainTextToHtml('Child of remote note'),
				visibility: 'public',
				inReplyTo: remoteParentIri,
			});
			const ids = await getMastodonIds([{ iri: child.id, published: child.published }]);
			const childId = ids.get(child.id)!;

			const res = await getContext(childId);
			expect(res.status).toBe(200);
			expect(res.body.ancestors).toEqual([]);
		});

		test('filters out invisible private replies from context', async () => {
			const { object: root } = await publishNote(me, {
				content: plainTextToHtml('Public root'),
				visibility: 'public',
			});
			// Alice creates a private reply
			const { object: privateReply } = await publishNote(alice, {
				content: plainTextToHtml('Private reply from alice'),
				visibility: 'private',
				inReplyTo: root.id,
			});
			// Alice creates a public reply
			const { object: publicReply } = await publishNote(alice, {
				content: plainTextToHtml('Public reply from alice'),
				visibility: 'public',
				inReplyTo: root.id,
			});

			const ids = await getMastodonIds([
				{ iri: root.id, published: root.published },
				{ iri: privateReply.id, published: privateReply.published },
				{ iri: publicReply.id, published: publicReply.published },
			]);
			const rootId = ids.get(root.id)!;
			const publicReplyId = ids.get(publicReply.id)!;

			// Unauthenticated request should only see the public reply in descendants
			const res = await getContext(rootId);
			expect(res.status).toBe(200);
			expect(res.body.descendants.map((s: { id: string }) => s.id)).toEqual([publicReplyId]);
		});

		test('finds descendants when inReplyTo is stored as an array (federated reply from remote actor)', async () => {
			const { object: root } = await publishNote(me, {
				content: plainTextToHtml('Root post for federation reply test'),
				visibility: 'public',
			});

			// 外部インスタンスから受信した Note (apex.fromJSONLD により inReplyTo は配列になる)
			const federatedReplyId = 'https://remote.example/notes/bob-reply-1';
			const published = new Date().toISOString();
			await apex.store.saveObject({
				id: federatedReplyId,
				type: 'Note',
				attributedTo: REMOTE_BOB,
				to: ['as:Public'],
				content: '<p>Reply from remote Bob</p>',
				published,
				inReplyTo: [root.id],
			} as unknown as APObject);

			const ids = await getMastodonIds([
				{ iri: root.id, published: root.published },
				{ iri: federatedReplyId, published },
			]);
			const rootId = ids.get(root.id)!;
			const bobReplyId = ids.get(federatedReplyId)!;

			// Root の context にリモート Bob の返信が descendants として含まれることを確認
			const res = await getContext(rootId);
			expect(res.status).toBe(200);
			expect(res.body.descendants.map((s: { id: string }) => s.id)).toEqual([bobReplyId]);

			// Bob の返信の context に Root が ancestors として含まれることも確認
			const bobRes = await getContext(bobReplyId);
			expect(bobRes.status).toBe(200);
			expect(bobRes.body.ancestors.map((s: { id: string }) => s.id)).toEqual([rootId]);
		});

		test('publishNote stores inReplyTo as an array of IRIs', async () => {
			const { object: root } = await publishNote(me, {
				content: plainTextToHtml('Root'),
				visibility: 'public',
			});
			const { object: reply } = await publishNote(me, {
				content: plainTextToHtml('Reply'),
				visibility: 'public',
				inReplyTo: root.id,
			});

			const stored = await apex.store.getObject(reply.id);
			expect(stored?.inReplyTo).toEqual([root.id]);
		});
	});

	describe('Status account ID and mentions resolution (Issue #154, ADR-0069)', () => {
		test('assigns real Snowflake ID to remote account in status.account.id', async () => {
			const published = '2026-03-01T12:00:00.000Z';
			const remoteNoteId = 'https://remote.example/notes/1';
			await apex.store.saveObject({
				id: remoteNoteId,
				type: 'Note',
				attributedTo: REMOTE_BOB,
				content: '<p>Hello from Bob</p>',
				to: 'as:Public',
				published,
			} as unknown as APObject);

			const ids = await getMastodonIds([
				{ iri: remoteNoteId, published },
				{ iri: REMOTE_BOB, published: undefined },
			]);
			const statusId = ids.get(remoteNoteId)!;
			const bobAccountId = ids.get(REMOTE_BOB)!;

			const res = await getStatus(statusId);
			expect(res.status).toBe(200);
			expect(res.body.account.id).toBe(bobAccountId);
			expect(res.body.account.username).toBe('bob');
			expect(res.body.account.acct).toBe('bob@remote.example');
			expect(res.body.account.id).not.toBe('1');
		});

		test('resolves mentions[].id to local user ID and remote user Snowflake IDs', async () => {
			const REMOTE_CAROL = 'https://remote.example/u/carol';
			await apex.store.saveObject({
				id: REMOTE_CAROL,
				type: 'Person',
				preferredUsername: 'carol',
				inbox: `${REMOTE_CAROL}/inbox`,
				outbox: `${REMOTE_CAROL}/outbox`,
			} as unknown as APObject);

			const published = '2026-03-01T13:00:00.000Z';
			const noteWithMentionsId = 'https://remote.example/notes/2';
			await apex.store.saveObject({
				id: noteWithMentionsId,
				type: 'Note',
				attributedTo: REMOTE_BOB,
				content: '<p>@hakatashi @carol hello!</p>',
				to: 'as:Public',
				published,
				tag: [
					{
						type: 'Mention',
						href: me.id,
						name: '@hakatashi',
					},
					{
						type: 'Mention',
						href: REMOTE_CAROL,
						name: '@carol@remote.example',
					},
				],
			} as unknown as APObject);

			const ids = await getMastodonIds([
				{ iri: noteWithMentionsId, published },
				{ iri: REMOTE_CAROL, published: undefined },
			]);
			const statusId = ids.get(noteWithMentionsId)!;
			const carolAccountId = ids.get(REMOTE_CAROL)!;

			const res = await getStatus(statusId);
			expect(res.status).toBe(200);
			expect(res.body.mentions).toEqual([
				{
					id: '1',
					username: 'hakatashi',
					acct: 'hakatashi',
					url: me.id,
				},
				{
					id: carolAccountId,
					username: 'carol',
					acct: 'carol@remote.example',
					url: REMOTE_CAROL,
				},
			]);
			expect(carolAccountId).not.toBe('1');
		});
	});

	describe('Viewer status interactions (Issue #155, ADR-0070)', () => {
		test('POST /api/v1/statuses/:id/favourite and /unfavourite', async () => {
			const { object: note } = await publishNote(alice, {
				content: plainTextToHtml('Post to favourite'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const statusId = ids.get(note.id)!;

			// 認証なし -> 401
			const unauthRes = await postStatusAction(statusId, 'favourite');
			expect(unauthRes.status).toBe(401);

			// 不足スコープ -> 403
			const forbiddenRes = await postStatusAction(statusId, 'favourite', 'me-read-token');
			expect(forbiddenRes.status).toBe(403);
			const wrongScopeRes = await postStatusAction(statusId, 'favourite', 'me-statuses-token');
			expect(wrongScopeRes.status).toBe(403);

			// 存在しないステータス -> 404
			const notFoundRes = await postStatusAction(
				'99999999999999999999',
				'favourite',
				'me-favourites-token',
			);
			expect(notFoundRes.status).toBe(404);

			// お気に入り登録
			const favRes = await postStatusAction(statusId, 'favourite', 'me-favourites-token');
			expect(favRes.status).toBe(200);
			expect(favRes.body.id).toBe(statusId);
			expect(favRes.body.favourited).toBe(true);

			// Streams に Like アクティビティが保存されている
			const likeStreams = await Streams.where('type', '==', 'Like')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(likeStreams.docs.length).toBe(1);

			// GET /statuses/:id での反映確認
			const meGetRes = await getStatus(statusId, 'me-token');
			expect(meGetRes.status).toBe(200);
			expect(meGetRes.body.favourited).toBe(true);

			// 他ユーザーまたは未認証からは favourited: false
			const aliceGetRes = await getStatus(statusId, 'alice-token');
			expect(aliceGetRes.status).toBe(200);
			expect(aliceGetRes.body.favourited).toBe(false);

			const anonGetRes = await getStatus(statusId);
			expect(anonGetRes.status).toBe(200);
			expect(anonGetRes.body.favourited).toBe(false);

			// 冪等性: 再度 favourite しても正常終了
			const reFavRes = await postStatusAction(statusId, 'favourite', 'me-favourites-token');
			expect(reFavRes.status).toBe(200);
			expect(reFavRes.body.favourited).toBe(true);

			// お気に入り解除
			const unfavRes = await postStatusAction(statusId, 'unfavourite', 'me-favourites-token');
			expect(unfavRes.status).toBe(200);
			expect(unfavRes.body.favourited).toBe(false);

			// Streams に Undo アクティビティが追加された
			const undoStreams = await Streams.where('type', '==', 'Undo')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(undoStreams.docs.length).toBe(1);

			// 解除後の GET 確認
			const meAfterGetRes = await getStatus(statusId, 'me-token');
			expect(meAfterGetRes.status).toBe(200);
			expect(meAfterGetRes.body.favourited).toBe(false);
		});

		test('POST /api/v1/statuses/:id/reblog and /unreblog', async () => {
			const { object: publicNote } = await publishNote(alice, {
				content: plainTextToHtml('Public post to reblog'),
				visibility: 'public',
			});
			const { object: directNote } = await publishNote(alice, {
				content: plainTextToHtml('Direct post to me'),
				visibility: 'direct',
				mentions: [me.id],
			});
			const { object: privateNote } = await publishNote(alice, {
				content: plainTextToHtml('Private post'),
				visibility: 'private',
			});

			const ids = await getMastodonIds([
				{ iri: publicNote.id, published: publicNote.published },
				{ iri: directNote.id, published: directNote.published },
				{ iri: privateNote.id, published: privateNote.published },
			]);
			const publicId = ids.get(publicNote.id)!;
			const directId = ids.get(directNote.id)!;
			const privateId = ids.get(privateNote.id)!;

			// 認証・スコープチェック
			const unauthRes = await postStatusAction(publicId, 'reblog');
			expect(unauthRes.status).toBe(401);

			const forbiddenRes = await postStatusAction(publicId, 'reblog', 'me-favourites-token');
			expect(forbiddenRes.status).toBe(403);

			// direct / private のブースト不可
			const directRes = await postStatusAction(directId, 'reblog', 'me-statuses-token');
			expect(directRes.status).toBe(422);

			// private (未フォロー) は 404
			const privateRes = await postStatusAction(privateId, 'reblog', 'me-statuses-token');
			expect(privateRes.status).toBe(404);

			// 公開投稿のブースト
			const reblogRes = await postStatusAction(publicId, 'reblog', 'me-statuses-token');
			expect(reblogRes.status).toBe(200);
			expect(reblogRes.body.reblogged).toBe(true);
			expect(reblogRes.body.id).not.toBe(publicId);
			expect(reblogRes.body.account.username).toBe('hakatashi');
			expect(reblogRes.body.content).toBe('<p>Public post to reblog</p>');
			expect(reblogRes.body.reblog).toBeDefined();
			expect(reblogRes.body.reblog.id).toBe(publicId);
			expect(reblogRes.body.reblog.account.username).toBe('alice');
			expect(reblogRes.body.reblog.reblogged).toBe(true);

			// ブーストの ID で GET /api/v1/statuses/:id が引ける
			const announceGetRes = await getStatus(reblogRes.body.id, 'me-token');
			expect(announceGetRes.status).toBe(200);
			expect(announceGetRes.body.id).toBe(reblogRes.body.id);
			expect(announceGetRes.body.account.username).toBe('hakatashi');
			expect(announceGetRes.body.reblog.id).toBe(publicId);

			// 既にブースト済みの状態で再度 POST /reblog しても同じブースト Status が返る (冪等性)
			const reblogRepeatRes = await postStatusAction(publicId, 'reblog', 'me-statuses-token');
			expect(reblogRepeatRes.status).toBe(200);
			expect(reblogRepeatRes.body.id).toBe(reblogRes.body.id);
			expect(reblogRepeatRes.body.reblog.id).toBe(publicId);

			// Streams に Announce アクティビティが保存されている
			const announceStreams = await Streams.where('type', '==', 'Announce')
				.where('actor', 'array-contains', me.id)
				.get();
			expect(announceStreams.docs.length).toBe(1);

			// GET /statuses/:id での反映確認
			const meGetRes = await getStatus(publicId, 'me-token');
			expect(meGetRes.status).toBe(200);
			expect(meGetRes.body.reblogged).toBe(true);

			const aliceGetRes = await getStatus(publicId, 'alice-token');
			expect(aliceGetRes.status).toBe(200);
			expect(aliceGetRes.body.reblogged).toBe(false);

			// ブースト解除
			const unreblogRes = await postStatusAction(publicId, 'unreblog', 'me-statuses-token');
			expect(unreblogRes.status).toBe(200);
			expect(unreblogRes.body.reblogged).toBe(false);

			// 解除後の GET 確認
			const meAfterGetRes = await getStatus(publicId, 'me-token');
			expect(meAfterGetRes.status).toBe(200);
			expect(meAfterGetRes.body.reblogged).toBe(false);
		});

		test('POST /api/v1/statuses/:id/favourite with a boost ID favourites the underlying note', async () => {
			const { object: note } = await publishNote(alice, {
				content: plainTextToHtml('Post to boost and favourite'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const noteId = ids.get(note.id)!;

			// Alice creates a reblog
			const reblogRes = await postStatusAction(noteId, 'reblog', 'alice-token');
			const boostId = reblogRes.body.id;

			// Me favourites using the boost ID
			const favRes = await postStatusAction(boostId, 'favourite', 'me-favourites-token');
			expect(favRes.status).toBe(200);
			expect(favRes.body.id).toBe(noteId);
			expect(favRes.body.favourited).toBe(true);

			// Original note is favourited
			const getRes = await getStatus(noteId, 'me-token');
			expect(getRes.body.favourited).toBe(true);
		});

		test('POST /api/v1/statuses/:id/bookmark and /unbookmark', async () => {
			const { object: note } = await publishNote(alice, {
				content: plainTextToHtml('Post to bookmark'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const statusId = ids.get(note.id)!;

			// 認証・スコープチェック
			const unauthRes = await postStatusAction(statusId, 'bookmark');
			expect(unauthRes.status).toBe(401);

			const forbiddenRes = await postStatusAction(statusId, 'bookmark', 'me-statuses-token');
			expect(forbiddenRes.status).toBe(403);

			// ブックマーク登録
			const bmRes = await postStatusAction(statusId, 'bookmark', 'me-bookmarks-token');
			expect(bmRes.status).toBe(200);
			expect(bmRes.body.bookmarked).toBe(true);

			// Firestore の bookmarks サブコレクションに保存されている
			const bmDoc = await UserInfos.doc(escapeFirestoreKey(me.id))
				.collection('bookmarks')
				.doc(escapeFirestoreKey(note.id))
				.get();
			expect(bmDoc.exists).toBe(true);

			// GET /statuses/:id での反映確認
			const meGetRes = await getStatus(statusId, 'me-token');
			expect(meGetRes.status).toBe(200);
			expect(meGetRes.body.bookmarked).toBe(true);

			// 他ユーザーからは bookmarked: false
			const aliceGetRes = await getStatus(statusId, 'alice-token');
			expect(aliceGetRes.status).toBe(200);
			expect(aliceGetRes.body.bookmarked).toBe(false);

			// ブックマーク解除
			const unbmRes = await postStatusAction(statusId, 'unbookmark', 'me-bookmarks-token');
			expect(unbmRes.status).toBe(200);
			expect(unbmRes.body.bookmarked).toBe(false);

			const bmDocAfter = await UserInfos.doc(escapeFirestoreKey(me.id))
				.collection('bookmarks')
				.doc(escapeFirestoreKey(note.id))
				.get();
			expect(bmDocAfter.exists).toBe(false);

			// 解除後の GET 確認
			const meAfterGetRes = await getStatus(statusId, 'me-token');
			expect(meAfterGetRes.status).toBe(200);
			expect(meAfterGetRes.body.bookmarked).toBe(false);
		});

		test('POST /api/v1/statuses/:id/pin and /unpin', async () => {
			const { object: myNote } = await publishNote(me, {
				content: plainTextToHtml('My note to pin'),
				visibility: 'public',
			});
			const { object: aliceNote } = await publishNote(alice, {
				content: plainTextToHtml('Alice note'),
				visibility: 'public',
			});
			const { object: directNote } = await publishNote(me, {
				content: plainTextToHtml('My direct note'),
				visibility: 'direct',
			});

			const ids = await getMastodonIds([
				{ iri: myNote.id, published: myNote.published },
				{ iri: aliceNote.id, published: aliceNote.published },
				{ iri: directNote.id, published: directNote.published },
			]);
			const myStatusId = ids.get(myNote.id)!;
			const aliceStatusId = ids.get(aliceNote.id)!;
			const directStatusId = ids.get(directNote.id)!;

			// 認証・スコープチェック
			const unauthRes = await postStatusAction(myStatusId, 'pin');
			expect(unauthRes.status).toBe(401);

			const forbiddenRes = await postStatusAction(myStatusId, 'pin', 'me-statuses-token');
			expect(forbiddenRes.status).toBe(403);

			// 他人の投稿をピン留めしようとすると 422
			const otherPinRes = await postStatusAction(aliceStatusId, 'pin', 'me-accounts-token');
			expect(otherPinRes.status).toBe(422);
			expect(otherPinRes.body.error).toBe('You can only pin your own posts');

			// ダイレクトメッセージをピン留めしようとすると 422
			const directPinRes = await postStatusAction(directStatusId, 'pin', 'me-accounts-token');
			expect(directPinRes.status).toBe(422);
			expect(directPinRes.body.error).toBe('You cannot pin direct posts');

			// 自分の公開投稿をピン留め
			const pinRes = await postStatusAction(myStatusId, 'pin', 'me-accounts-token');
			expect(pinRes.status).toBe(200);
			expect(pinRes.body.pinned).toBe(true);

			// Firestore の pins サブコレクションに保存されている
			const pinDoc = await UserInfos.doc(escapeFirestoreKey(me.id))
				.collection('pins')
				.doc(escapeFirestoreKey(myNote.id))
				.get();
			expect(pinDoc.exists).toBe(true);

			// GET /statuses/:id での反映確認
			const meGetRes = await getStatus(myStatusId, 'me-token');
			expect(meGetRes.status).toBe(200);
			expect(meGetRes.body.pinned).toBe(true);

			// 他ユーザーからは pinned: false (本人のピン留めフラグ)
			const aliceGetRes = await getStatus(myStatusId, 'alice-token');
			expect(aliceGetRes.status).toBe(200);
			expect(aliceGetRes.body.pinned).toBe(false);

			// GET /accounts/:id/statuses?pinned=true で取得できる
			const accountStatusesRes = await request(mastodon)
				.get('/api/v1/accounts/1/statuses?pinned=true')
				.set('Authorization', 'Bearer me-token');
			expect(accountStatusesRes.status).toBe(200);
			expect(accountStatusesRes.body.length).toBe(1);
			expect(accountStatusesRes.body[0].id).toBe(myStatusId);
			expect(accountStatusesRes.body[0].pinned).toBe(true);

			// ピン留め解除
			const unpinRes = await postStatusAction(myStatusId, 'unpin', 'me-accounts-token');
			expect(unpinRes.status).toBe(200);
			expect(unpinRes.body.pinned).toBe(false);

			const pinDocAfter = await UserInfos.doc(escapeFirestoreKey(me.id))
				.collection('pins')
				.doc(escapeFirestoreKey(myNote.id))
				.get();
			expect(pinDocAfter.exists).toBe(false);

			// 解除後の GET 確認
			const meAfterGetRes = await getStatus(myStatusId, 'me-token');
			expect(meAfterGetRes.status).toBe(200);
			expect(meAfterGetRes.body.pinned).toBe(false);

			const accountStatusesAfterRes = await request(mastodon)
				.get('/api/v1/accounts/1/statuses?pinned=true')
				.set('Authorization', 'Bearer me-token');
			expect(accountStatusesAfterRes.status).toBe(200);
			expect(accountStatusesAfterRes.body).toEqual([]);
		});

		test('GET /api/v1/timelines/public returns viewer interaction attributes', async () => {
			const { object: note } = await publishNote(alice, {
				content: plainTextToHtml('Timeline status'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const statusId = ids.get(note.id)!;

			// favourite & bookmark
			await postStatusAction(statusId, 'favourite', 'me-token');
			await postStatusAction(statusId, 'bookmark', 'me-token');

			// Public timeline with me-token
			const meTlRes = await request(mastodon)
				.get('/api/v1/timelines/public')
				.set('Authorization', 'Bearer me-token');
			expect(meTlRes.status).toBe(200);
			const meStatus = meTlRes.body.find((s: { id: string }) => s.id === statusId);
			expect(meStatus).toBeDefined();
			expect(meStatus.favourited).toBe(true);
			expect(meStatus.bookmarked).toBe(true);
			expect(meStatus.reblogged).toBe(false);

			// Public timeline with alice-token
			const aliceTlRes = await request(mastodon)
				.get('/api/v1/timelines/public')
				.set('Authorization', 'Bearer alice-token');
			expect(aliceTlRes.status).toBe(200);
			const aliceStatus = aliceTlRes.body.find((s: { id: string }) => s.id === statusId);
			expect(aliceStatus).toBeDefined();
			expect(aliceStatus.favourited).toBe(false);
			expect(aliceStatus.bookmarked).toBe(false);
		});
	});
});
