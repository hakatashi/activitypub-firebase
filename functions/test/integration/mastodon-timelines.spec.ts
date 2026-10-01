import type { APObject } from 'activitypub-types';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { apex } from '../../src/activitypub.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import {
	getAccountStatuses,
	getFollowing,
	getHomeTimeline,
	getPublicTimeline,
} from '../../src/mastodon/api.js';
import { toIdIndex } from '../../src/meta.js';
import { Streams } from '../../src/schema.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const REMOTE_A = 'https://remote.example/u/alice';
const REMOTE_B = 'https://remote.example/u/bob';

describe('Mastodon timelines (Issue #58)', () => {
	let me: Awaited<ReturnType<typeof apex.createActor>>;
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

	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		me = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
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
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	const follow = async (target: string, accepted: boolean) => {
		const followId = `${me.id}/follows/${target}`;
		await Streams.doc(escapeFirestoreKey(followId)).set({
			id: followId,
			type: 'Follow',
			actor: me.id,
			object: target,
			_meta: {
				index: { collections: {}, actors: toIdIndex([me.id]), objects: toIdIndex([target]) },
			},
		} as never);
		if (accepted) {
			const acceptId = `${target}/accepts/1`;
			await Streams.doc(escapeFirestoreKey(acceptId)).set({
				id: acceptId,
				type: 'Accept',
				actor: target,
				object: followId,
				_meta: {
					index: {
						collections: toIdIndex([`${me.id}/inbox`]),
						actors: toIdIndex([target]),
						objects: toIdIndex([followId]),
					},
				},
			} as never);
		}
	};

	test('public timeline contains only public notes', async () => {
		const publicId = await saveNote(REMOTE_A, 'public');
		await saveNote(REMOTE_A, 'unlisted');
		await saveNote(REMOTE_A, 'private');
		await saveNote(REMOTE_A, 'direct');
		const statuses = await getPublicTimeline(20);
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
		const statuses = await getPublicTimeline(3);
		expect(statuses).toHaveLength(3);
		expect(statuses.every((s) => s.visibility === 'public')).toBe(true);
	});

	test('account statuses are filtered by actor and viewer permissions', async () => {
		const a1 = await saveNote(REMOTE_A, 'public');
		const a2 = await saveNote(REMOTE_A, 'unlisted');
		await saveNote(REMOTE_A, 'private');
		await saveNote(REMOTE_A, 'direct');
		await saveNote(REMOTE_B, 'public');

		const anonymous = await getAccountStatuses(REMOTE_A, undefined, 20);
		expect(anonymous.map((s) => s.uri).sort()).toEqual([a1, a2].sort());

		await follow(REMOTE_A, true);
		const asFollower = await getAccountStatuses(REMOTE_A, me, 20);
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

		const statuses = await getHomeTimeline(me, 20);
		expect(statuses.map((s) => s.uri).sort()).toEqual(
			[mine, followedPublic, followedPrivate].sort(),
		);
	});
});
