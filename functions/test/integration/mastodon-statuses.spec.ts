import type { APObject } from 'activitypub-types';
import firebase from 'firebase-admin';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/activitypub.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { plainTextToHtml, publishNote } from '../../src/notes.js';
import { AccessTokens, Streams, UserInfos } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const UID_ME = 'uid-hakatashi';
const UID_ALICE = 'uid-alice';
const REMOTE_BOB = 'https://remote.example/u/bob';

describe('GET / DELETE /api/v1/statuses/:id and /context (Issue #61)', () => {
	let me: Awaited<ReturnType<typeof apex.createActor>>;
	let alice: Awaited<ReturnType<typeof apex.createActor>>;

	const addToken = async (token: string, scope: string, uid = UID_ME) => {
		const farFuture = firebase.firestore.Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
		await AccessTokens.add({
			accessToken: token,
			accessTokenExpiresAt: farFuture,
			refreshTokenExpiresAt: farFuture,
			scope,
			client: { id: '1', grants: [] },
			user: { userId: uid },
		} as never);
	};

	const getStatus = (id: string, token?: string) => {
		const req = request(mastodon).get(`/api/v1/statuses/${id}`);
		if (token !== undefined) {
			req.set('Authorization', `Bearer ${token}`);
		}
		return req;
	};

	const deleteStatus = (id: string, token?: string) => {
		const req = request(mastodon).delete(`/api/v1/statuses/${id}`);
		if (token !== undefined) {
			req.set('Authorization', `Bearer ${token}`);
		}
		return req;
	};

	const getContext = (id: string, token?: string) => {
		const req = request(mastodon).get(`/api/v1/statuses/${id}/context`);
		if (token !== undefined) {
			req.set('Authorization', `Bearer ${token}`);
		}
		return req;
	};

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);

		me = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
		await apex.store.saveObject(me);
		await UserInfos.doc(escapeFirestoreKey(me.id)).set({
			id: '1',
			uid: UID_ME,
			locked: false,
			bot: false,
			created_at: '2026-01-01T00:00:00.000Z',
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: '',
			emojis: [],
			fields: [],
			roles: [],
		});

		alice = await apex.createActor('alice', 'alice', '', '', 'Person');
		await apex.store.saveObject(alice);
		await UserInfos.doc(escapeFirestoreKey(alice.id)).set({
			id: '2',
			uid: UID_ALICE,
			locked: false,
			bot: false,
			created_at: '2026-01-01T00:00:00.000Z',
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: '',
			emojis: [],
			fields: [],
			roles: [],
		});

		await apex.store.saveObject({
			id: REMOTE_BOB,
			type: 'Person',
			preferredUsername: 'bob',
			inbox: `${REMOTE_BOB}/inbox`,
			outbox: `${REMOTE_BOB}/outbox`,
		} as unknown as APObject);

		await addToken('me-token', 'read write follow', UID_ME);
		await addToken('me-statuses-token', 'write:statuses', UID_ME);
		await addToken('me-read-token', 'read', UID_ME);
		await addToken('alice-token', 'read write follow', UID_ALICE);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
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
			} as APObject);

			await apex.store.saveObject({
				id: idB,
				type: 'Note',
				attributedTo: me.id,
				to: ['as:Public'],
				content: '<p>Cycle B</p>',
				published: new Date().toISOString(),
				inReplyTo: idA,
			} as APObject);

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
	});
});
