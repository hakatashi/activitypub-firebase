import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { activitypub } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { deleteNote, plainTextToHtml, publishNote } from '../../src/notes.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { getFeaturedCollection } from '../../src/social/pins.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import {
	LOCAL_USERNAME,
	localActorId,
	localFeaturedId,
	localFollowersId,
} from '../../src/localActor.js';
import { Objects, UserInfos } from '../../src/schema.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const FOLLOWER_ALICE_ID = 'https://remote-a.example/u/alice';
const FOLLOWER_ALICE_INBOX = 'https://remote-a.example/u/alice/inbox';
const UID_ME = 'uid-hakatashi';

describe('pinned statuses and featured collection (Issue #319)', () => {
	let me: LocalActor;
	let meAccountsToken: string;
	let deliveryEnqueueSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		process.env.HAKATASHI_TOKEN = 'test-token';
		deliveryEnqueueSpy = vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		me = await createLocalActor(LOCAL_USERNAME, { uid: UID_ME, id: '1' });

		// Alice as remote follower
		await apex.store.saveObject({
			id: FOLLOWER_ALICE_ID,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: [FOLLOWER_ALICE_INBOX],
			outbox: [`${FOLLOWER_ALICE_ID}/outbox`],
		});
		await apex.store.saveActivity({
			id: 'https://remote-a.example/activities/follow-1',
			type: 'Follow',
			actor: [FOLLOWER_ALICE_ID],
			object: [localActorId],
			_meta: {
				collection: [localFollowersId],
			},
		});

		// OAuth tokens for Mastodon API
		await addAccessToken('me-accounts-token', 'read write:accounts', UID_ME);
		meAccountsToken = 'me-accounts-token';
	});

	afterEach(async () => {
		await resetFirestore();
		vi.restoreAllMocks();
		delete process.env.HAKATASHI_TOKEN;
	});

	describe('actor endpoint (routes.actor)', () => {
		test('GET /activitypub/u/:actor includes featured property and toot:featured context', async () => {
			const res = await request(activitypub)
				.get(`/activitypub/u/${LOCAL_USERNAME}`)
				.set('Accept', 'application/activity+json');

			expect(res.status).toBe(200);
			expect(res.body.featured).toBe(localFeaturedId);
			expect(res.body['@context']).toBeDefined();

			const contexts = Array.isArray(res.body['@context'])
				? res.body['@context']
				: [res.body['@context']];
			const hasTootFeatured = contexts.some(
				(ctx: unknown) =>
					typeof ctx === 'object' &&
					ctx !== null &&
					(ctx as Record<string, unknown>).featured !== undefined,
			);
			expect(hasTootFeatured).toBe(true);
		});
	});

	describe('featured collection endpoint (routes.featured)', () => {
		test('returns empty OrderedCollection when no posts are pinned', async () => {
			const res = await request(activitypub)
				.get(`/activitypub/u/${LOCAL_USERNAME}/collections/featured`)
				.set('Accept', 'application/activity+json');

			expect(res.status).toBe(200);
			expect(res.body.type).toBe('OrderedCollection');
			expect(res.body.id).toBe(localFeaturedId);
			expect(res.body.totalItems).toBe(0);
			expect(res.body.orderedItems).toEqual([]);
		});

		test('returns public and unlisted pinned posts, hiding private posts from unauthenticated requests', async () => {
			const { object: publicNote1 } = await publishNote(me, {
				content: plainTextToHtml('First public post'),
				visibility: 'public',
			});
			const { object: privateNote } = await publishNote(me, {
				content: plainTextToHtml('Private post for followers only'),
				visibility: 'private',
			});
			const { object: unlistedNote } = await publishNote(me, {
				content: plainTextToHtml('Unlisted post'),
				visibility: 'unlisted',
			});
			const { object: publicNote2 } = await publishNote(me, {
				content: plainTextToHtml('Second public post'),
				visibility: 'public',
			});

			const pinsCollection = UserInfos.doc(escapeFirestoreKey(me.id)).collection('pins');
			// Pin in chronological sequence
			await pinsCollection
				.doc(escapeFirestoreKey(publicNote1.id))
				.set({ noteIri: publicNote1.id, createdAt: new Date('2026-10-24T10:00:00Z') });
			await pinsCollection
				.doc(escapeFirestoreKey(privateNote.id))
				.set({ noteIri: privateNote.id, createdAt: new Date('2026-10-24T10:01:00Z') });
			await pinsCollection
				.doc(escapeFirestoreKey(unlistedNote.id))
				.set({ noteIri: unlistedNote.id, createdAt: new Date('2026-10-24T10:02:00Z') });
			await pinsCollection
				.doc(escapeFirestoreKey(publicNote2.id))
				.set({ noteIri: publicNote2.id, createdAt: new Date('2026-10-24T10:03:00Z') });

			// Unauthenticated request: privateNote MUST NOT be included
			const unauthRes = await request(activitypub)
				.get(`/activitypub/u/${LOCAL_USERNAME}/collections/featured`)
				.set('Accept', 'application/activity+json');

			expect(unauthRes.status).toBe(200);
			expect(unauthRes.body.type).toBe('OrderedCollection');
			expect(unauthRes.body.totalItems).toBe(3);

			const unauthItemIds = unauthRes.body.orderedItems.map((item: { id: string }) => item.id);
			// Ordered by createdAt desc: publicNote2, unlistedNote, publicNote1
			expect(unauthItemIds).toEqual([publicNote2.id, unlistedNote.id, publicNote1.id]);
			expect(unauthItemIds).not.toContain(privateNote.id);

			// Embedded note objects should not leak private _meta
			for (const item of unauthRes.body.orderedItems) {
				expect(item._meta).toBeUndefined();
				expect(item.type).toBe('Note');
			}
		});

		test('returns all pinned posts including private when request is authorized as the owner', async () => {
			const { object: publicNote } = await publishNote(me, {
				content: plainTextToHtml('Public post'),
				visibility: 'public',
			});
			const { object: privateNote } = await publishNote(me, {
				content: plainTextToHtml('Private post'),
				visibility: 'private',
			});

			const pinsCollection = UserInfos.doc(escapeFirestoreKey(me.id)).collection('pins');
			await pinsCollection
				.doc(escapeFirestoreKey(publicNote.id))
				.set({ noteIri: publicNote.id, createdAt: new Date('2026-10-24T10:00:00Z') });
			await pinsCollection
				.doc(escapeFirestoreKey(privateNote.id))
				.set({ noteIri: privateNote.id, createdAt: new Date('2026-10-24T10:01:00Z') });

			// getFeaturedCollection with authorized = true should include private notes
			const collection = await getFeaturedCollection(me, true);
			expect(collection.type).toBe('OrderedCollection');
			expect(collection.totalItems).toBe(2);
			const authItemIds = (collection.orderedItems as Array<{ id: string }>).map((item) => item.id);
			expect(authItemIds).toEqual([privateNote.id, publicNote.id]);
		});

		test('returns 404 for non-existent actor', async () => {
			const res = await request(activitypub)
				.get('/activitypub/u/nonexistent/collections/featured')
				.set('Accept', 'application/activity+json');

			expect(res.status).toBe(404);
		});
	});

	describe('delivery of Add / Remove on pin and unpin (Mastodon API)', () => {
		test('POST /api/v1/statuses/:id/pin delivers Add activity to followers via Cloud Tasks', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Note to pin'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const statusId = ids.get(note.id)!;

			deliveryEnqueueSpy.mockClear();

			// Pin the status
			const pinRes = await request(mastodon)
				.post(`/api/v1/statuses/${statusId}/pin`)
				.set('Authorization', `Bearer ${meAccountsToken}`);

			expect(pinRes.status).toBe(200);
			expect(pinRes.body.pinned).toBe(true);

			// deliveryEnqueue should be called for Alice's inbox
			expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(1);
			const [actorId, bodyString, recipients] = deliveryEnqueueSpy.mock.calls[0] ?? [];
			expect(actorId).toBe(localActorId);
			expect(recipients).toContain(FOLLOWER_ALICE_INBOX);

			const activity = JSON.parse(bodyString as string);
			expect(activity.type).toBe('Add');
			expect(activity.actor).toBe(localActorId);
			expect(activity.target).toBe(localFeaturedId);
			expect(activity.object).toBe(note.id);
			expect(activity.id).toBeDefined();

			// Pinning already pinned post should be idempotent and NOT deliver Add again
			deliveryEnqueueSpy.mockClear();
			const pinAgainRes = await request(mastodon)
				.post(`/api/v1/statuses/${statusId}/pin`)
				.set('Authorization', `Bearer ${meAccountsToken}`);
			expect(pinAgainRes.status).toBe(200);
			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
		});

		test('POST /api/v1/statuses/:id/unpin delivers Remove activity to followers via Cloud Tasks', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Note to unpin'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const statusId = ids.get(note.id)!;

			// Pin first
			await request(mastodon)
				.post(`/api/v1/statuses/${statusId}/pin`)
				.set('Authorization', `Bearer ${meAccountsToken}`);

			deliveryEnqueueSpy.mockClear();

			// Unpin the status
			const unpinRes = await request(mastodon)
				.post(`/api/v1/statuses/${statusId}/unpin`)
				.set('Authorization', `Bearer ${meAccountsToken}`);

			expect(unpinRes.status).toBe(200);
			expect(unpinRes.body.pinned).toBe(false);

			// deliveryEnqueue should be called with Remove activity
			expect(deliveryEnqueueSpy).toHaveBeenCalledTimes(1);
			const [actorId, bodyString, recipients] = deliveryEnqueueSpy.mock.calls[0] ?? [];
			expect(actorId).toBe(localActorId);
			expect(recipients).toContain(FOLLOWER_ALICE_INBOX);

			const activity = JSON.parse(bodyString as string);
			expect(activity.type).toBe('Remove');
			expect(activity.actor).toBe(localActorId);
			expect(activity.target).toBe(localFeaturedId);
			expect(activity.object).toBe(note.id);
			expect(activity.id).toBeDefined();

			// Unpinning already unpinned post should NOT deliver Remove again
			deliveryEnqueueSpy.mockClear();
			const unpinAgainRes = await request(mastodon)
				.post(`/api/v1/statuses/${statusId}/unpin`)
				.set('Authorization', `Bearer ${meAccountsToken}`);
			expect(unpinAgainRes.status).toBe(200);
			expect(deliveryEnqueueSpy).not.toHaveBeenCalled();
		});

		test('deleteNote removes pin and delivers Remove activity if post was pinned', async () => {
			const { object: note } = await publishNote(me, {
				content: plainTextToHtml('Pinned note to be deleted'),
				visibility: 'public',
			});
			const ids = await getMastodonIds([{ iri: note.id, published: note.published }]);
			const statusId = ids.get(note.id)!;

			// Pin the note
			await request(mastodon)
				.post(`/api/v1/statuses/${statusId}/pin`)
				.set('Authorization', `Bearer ${meAccountsToken}`);

			const pinDoc = await UserInfos.doc(escapeFirestoreKey(me.id))
				.collection('pins')
				.doc(escapeFirestoreKey(note.id))
				.get();
			expect(pinDoc.exists).toBe(true);

			deliveryEnqueueSpy.mockClear();

			// Delete the note
			await deleteNote(me, note);

			const pinDocAfter = await UserInfos.doc(escapeFirestoreKey(me.id))
				.collection('pins')
				.doc(escapeFirestoreKey(note.id))
				.get();
			expect(pinDocAfter.exists).toBe(false);

			// Should deliver Remove activity (in addition to Delete activity)
			const removeCalls = deliveryEnqueueSpy.mock.calls.filter((call: unknown[]) => {
				const body = JSON.parse(call[1] as string);
				return body.type === 'Remove';
			});
			expect(removeCalls.length).toBe(1);
			const removeActivity = JSON.parse(removeCalls[0]?.[1] as string);
			expect(removeActivity.type).toBe('Remove');
			expect(removeActivity.target).toBe(localFeaturedId);
			expect(removeActivity.object).toBe(note.id);
		});
	});

	describe('/activitypub/publishProfileUpdate', () => {
		test('ensures featured on actor and delivers Update(Person) with featured', async () => {
			// Remove featured from actor in Firestore to simulate pre-existing actor
			const actorDoc = await Objects.doc(escapeFirestoreKey(localActorId)).get();
			const actorData = actorDoc.data()!;
			delete actorData.featured;
			await Objects.doc(escapeFirestoreKey(localActorId)).set(actorData);

			deliveryEnqueueSpy.mockClear();

			const res = await request(activitypub)
				.get('/activitypub/publishProfileUpdate')
				.set('x-hakatashi-token', 'test-token');
			expect(res.status).toBe(200);

			// Actor in Firestore should now have featured
			const updatedActorDoc = await Objects.doc(escapeFirestoreKey(localActorId)).get();
			expect(updatedActorDoc.data()?.featured).toBe(localFeaturedId);

			// Update(Person) activity should have been delivered
			expect(deliveryEnqueueSpy).toHaveBeenCalled();
			const updateCalls = deliveryEnqueueSpy.mock.calls.filter((call: unknown[]) => {
				const body = JSON.parse(call[1] as string);
				return body.type === 'Update';
			});
			expect(updateCalls.length).toBe(1);
			const updateActivity = JSON.parse(updateCalls[0]?.[1] as string);
			expect(updateActivity.object.featured).toBe(localFeaturedId);
		});
	});
});
