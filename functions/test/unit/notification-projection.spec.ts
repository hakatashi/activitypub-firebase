import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { APObject } from '../../src/apex/index.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { plainTextToHtml, publishNote } from '../../src/notes.js';
import { rebuildNotificationProjection } from '../../src/projections/notifications.js';
import { Notifications, Streams } from '../../src/schema.js';
import type { NotificationRecord } from '../../src/schema.js';
import { createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID_ME = 'uid-hakatashi';
const REMOTE_BOB = 'https://remote.example/u/bob';
const REMOTE_ALICE = 'https://remote.example/u/alice';

describe('notification projection (Issue #221, ADR-0088)', () => {
	let me: LocalActor;
	let myNote: APObject;

	const getNotifications = async (): Promise<NotificationRecord[]> => {
		const docs = await Notifications(escapeFirestoreKey(me.id)).get();
		return docs.docs.map((doc) => doc.data());
	};

	beforeEach(async () => {
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
		vi.spyOn(apex, 'publishUpdate').mockResolvedValue(undefined as never);
		me = await createLocalActor('hakatashi', { uid: UID_ME, id: '1' });
		({ object: myNote } = await publishNote(me, {
			content: plainTextToHtml('Hello world from me'),
			visibility: 'public',
		}));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('mention notifications', () => {
		test('creates mention notification when receiving Create(Note) with local actor in tag Mention', async () => {
			const noteIri = 'https://remote.example/notes/bob-1';
			const activityIri = 'https://remote.example/activities/bob-create-1';
			await apex.store.saveActivity({
				id: activityIri,
				type: 'Create',
				actor: REMOTE_BOB,
				published: '2026-10-07T12:00:00Z',
				object: [
					{
						id: noteIri,
						type: 'Note',
						attributedTo: REMOTE_BOB,
						content: 'Hello @hakatashi',
						tag: [
							{
								type: 'Mention',
								href: me.id,
								name: '@hakatashi',
							},
						],
					},
				],
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			const notifications = await getNotifications();
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatchObject({
				type: 'mention',
				activityIri,
				accountIri: REMOTE_BOB,
				statusIri: noteIri,
			});
			expect(notifications[0]?.id).toBeDefined();
		});

		test('does not create mention notification if Note tag does not mention local actor', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/activities/bob-create-2',
				type: 'Create',
				actor: REMOTE_BOB,
				object: [
					{
						id: 'https://remote.example/notes/bob-2',
						type: 'Note',
						attributedTo: REMOTE_BOB,
						content: 'Hello @alice',
						tag: [
							{
								type: 'Mention',
								href: REMOTE_ALICE,
								name: '@alice',
							},
						],
					},
				],
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});

		test('does not create mention notification if local actor is only in to/cc without Mention tag (silent mention)', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/activities/bob-create-3',
				type: 'Create',
				actor: REMOTE_BOB,
				to: [me.id],
				object: [
					{
						id: 'https://remote.example/notes/bob-3',
						type: 'Note',
						attributedTo: REMOTE_BOB,
						to: [me.id],
						content: 'Direct message to you',
					},
				],
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});

		test('does not create mention notification from local actor own Note', async () => {
			// publishNote creates Note and Create activity from local actor
			const initialCount = (await getNotifications()).length;
			await publishNote(me, {
				content: plainTextToHtml('Self mention @hakatashi'),
				visibility: 'public',
			});

			expect((await getNotifications()).length).toBe(initialCount);
		});
	});

	describe('favourite notifications', () => {
		test('creates favourite notification when remote actor likes local actor Note', async () => {
			const activityIri = 'https://remote.example/likes/bob-1';
			await apex.store.saveActivity({
				id: activityIri,
				type: 'Like',
				actor: REMOTE_BOB,
				object: myNote.id,
				published: '2026-10-07T12:05:00Z',
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			const notifications = await getNotifications();
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatchObject({
				type: 'favourite',
				activityIri,
				accountIri: REMOTE_BOB,
				statusIri: myNote.id,
			});
			expect(notifications[0]?.id).toBeDefined();
		});

		test('does not create favourite notification for Note of another actor', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/likes/bob-2',
				type: 'Like',
				actor: REMOTE_BOB,
				object: 'https://remote.example/notes/other-1',
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});

		test('does not create favourite notification when local actor likes own Note', async () => {
			await apex.store.saveActivity({
				id: `${me.id}/likes/1`,
				type: 'Like',
				actor: me.id,
				object: myNote.id,
				_meta: { collection: [`${me.id}/outbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});
	});

	describe('reblog notifications', () => {
		test('creates reblog notification when remote actor announces local actor Note', async () => {
			const activityIri = 'https://remote.example/announces/bob-1';
			await apex.store.saveActivity({
				id: activityIri,
				type: 'Announce',
				actor: REMOTE_BOB,
				object: myNote.id,
				published: '2026-10-07T12:10:00Z',
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			const notifications = await getNotifications();
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatchObject({
				type: 'reblog',
				activityIri,
				accountIri: REMOTE_BOB,
				statusIri: myNote.id,
			});
			expect(notifications[0]?.id).toBeDefined();
		});

		test('does not create reblog notification for Note of another actor', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/announces/bob-2',
				type: 'Announce',
				actor: REMOTE_BOB,
				object: 'https://remote.example/notes/other-1',
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});

		test('does not create reblog notification when local actor announces own Note', async () => {
			await apex.store.saveActivity({
				id: `${me.id}/announces/1`,
				type: 'Announce',
				actor: me.id,
				object: myNote.id,
				_meta: { collection: [`${me.id}/outbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});
	});

	describe('follow notifications', () => {
		test('creates follow notification when remote actor follows local actor', async () => {
			const activityIri = 'https://remote.example/follows/bob-1';
			await apex.store.saveActivity({
				id: activityIri,
				type: 'Follow',
				actor: REMOTE_BOB,
				object: me.id,
				published: '2026-10-07T12:15:00Z',
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			const notifications = await getNotifications();
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatchObject({
				type: 'follow',
				activityIri,
				accountIri: REMOTE_BOB,
				statusIri: null,
			});
			expect(notifications[0]?.id).toBeDefined();
		});

		test('does not create follow notification when remote actor follows someone else', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/follows/bob-2',
				type: 'Follow',
				actor: REMOTE_BOB,
				object: REMOTE_ALICE,
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});

		test('does not create follow notification when local actor follows remote actor', async () => {
			await apex.store.saveActivity({
				id: `${me.id}/follows/1`,
				type: 'Follow',
				actor: me.id,
				object: REMOTE_BOB,
				_meta: { collection: [`${me.id}/outbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});
	});

	describe('Undo and removal', () => {
		test('removes notification when activity is removed via removeActivity', async () => {
			const likeIri = 'https://remote.example/likes/bob-remove-1';
			await apex.store.saveActivity({
				id: likeIri,
				type: 'Like',
				actor: REMOTE_BOB,
				object: myNote.id,
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(1);

			// Remote actor undoes the like
			await apex.store.removeActivity({ id: likeIri, type: 'Like' } as APObject, REMOTE_BOB);

			expect(await getNotifications()).toHaveLength(0);
		});

		test('does not remove notification when non-author attempts removeActivity', async () => {
			const likeIri = 'https://remote.example/likes/bob-remove-2';
			await apex.store.saveActivity({
				id: likeIri,
				type: 'Like',
				actor: REMOTE_BOB,
				object: myNote.id,
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(1);

			// Attempt remove with different actor ID
			await apex.store.removeActivity({ id: likeIri, type: 'Like' } as APObject, REMOTE_ALICE);

			expect(await getNotifications()).toHaveLength(1);
		});
	});

	describe('deduplication and idempotency', () => {
		test('duplicate delivery does not create duplicate notifications', async () => {
			const likeIri = 'https://remote.example/likes/bob-dedup-1';
			const activity = {
				id: likeIri,
				type: 'Like',
				actor: REMOTE_BOB,
				object: myNote.id,
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject;

			await apex.store.saveActivity(activity);
			expect(await getNotifications()).toHaveLength(1);

			// Redeliver identical activity
			await apex.store.saveActivity(activity);
			expect(await getNotifications()).toHaveLength(1);

			// Redeliver to another collection (new collection)
			await apex.store.saveActivity({
				...activity,
				_meta: { collection: [`${me.id}/inbox`, `${me.id}/liked`] },
			} as APObject);
			expect(await getNotifications()).toHaveLength(1);
		});
	});

	describe('unsupported activity types', () => {
		test('does not create notifications for Update, Delete, etc.', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/updates/bob-1',
				type: 'Update',
				actor: REMOTE_BOB,
				object: { id: 'https://remote.example/notes/bob-1', type: 'Note' },
				_meta: { collection: [`${me.id}/inbox`] },
			} as APObject);

			expect(await getNotifications()).toHaveLength(0);
		});
	});

	describe('rebuildNotificationProjection (backfill)', () => {
		test('reconstructs notifications from activities in streams', async () => {
			// Add activities directly to streams
			const followIri = 'https://remote.example/follows/bob-backfill';
			const likeIri = 'https://remote.example/likes/bob-backfill';
			const undoneLikeIri = 'https://remote.example/likes/bob-undone';
			const undoIri = 'https://remote.example/undo/bob-undo-1';

			await Streams.doc(escapeFirestoreKey(followIri)).set({
				id: followIri,
				type: 'Follow',
				actor: REMOTE_BOB,
				object: me.id,
				published: '2026-10-07T10:00:00Z',
			} as APObject);

			await Streams.doc(escapeFirestoreKey(likeIri)).set({
				id: likeIri,
				type: 'Like',
				actor: REMOTE_BOB,
				object: myNote.id,
				published: '2026-10-07T10:05:00Z',
			} as APObject);

			await Streams.doc(escapeFirestoreKey(undoneLikeIri)).set({
				id: undoneLikeIri,
				type: 'Like',
				actor: REMOTE_BOB,
				object: myNote.id,
				published: '2026-10-07T10:10:00Z',
			} as APObject);

			await Streams.doc(escapeFirestoreKey(undoIri)).set({
				id: undoIri,
				type: 'Undo',
				actor: REMOTE_BOB,
				object: undoneLikeIri,
				published: '2026-10-07T10:15:00Z',
			} as APObject);

			// Test dry-run first
			const dryRunStats = await rebuildNotificationProjection({ dryRun: true });
			expect(dryRunStats.written).toBe(2);
			expect(dryRunStats.follow).toBe(1);
			expect(dryRunStats.favourite).toBe(1);
			expect(await getNotifications()).toHaveLength(0);

			// Actual run
			const stats = await rebuildNotificationProjection({ dryRun: false });
			expect(stats.written).toBe(2);
			expect(stats.follow).toBe(1);
			expect(stats.favourite).toBe(1);

			const notifications = await getNotifications();
			expect(notifications).toHaveLength(2);
			const iris = notifications.map((n) => n.activityIri).sort();
			expect(iris).toEqual([followIri, likeIri].sort());

			// Running again should write 0 (idempotent)
			const rerunStats = await rebuildNotificationProjection({ dryRun: false });
			expect(rerunStats.written).toBe(0);
			expect(rerunStats.deleted).toBe(0);
		});
	});
});
