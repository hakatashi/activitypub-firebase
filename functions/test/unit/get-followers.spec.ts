import type {APActor} from 'activitypub-types';
import {describe, expect, test, afterEach, beforeEach} from 'vitest';
import {apex} from '../../src/activitypub.js';
import {db} from '../../src/firebase.js';
import {getFollowers} from '../../src/mastodon/api.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const actor = {
	id: 'https://example.com/activitypub/u/hakatashi',
	type: 'Person',
	preferredUsername: 'hakatashi',
	inbox: 'https://example.com/activitypub/u/hakatashi/inbox',
} as unknown as APActor;

describe('getFollowers', () => {
	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		await apex.store.saveObject(actor);
	});

	// Teardown firestore database after each test
	afterEach(async () => {
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{
				method: 'DELETE',
			},
		);
	});

	test('returns an empty array when nobody has followed the actor', async () => {
		expect(await getFollowers(actor)).toEqual([]);
	});

	test('counts a follower with a single Follow activity', async () => {
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({id: followerId, type: 'Person', preferredUsername: 'alice'});
		await db.collection('streams').doc('follow-1').set({
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: [followerId],
			object: [actor.id],
		});

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0].acct).toBe('alice@remote.example');
	});

	test('excludes a follower whose Follow was later undone', async () => {
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({id: followerId, type: 'Person', preferredUsername: 'alice'});
		await db.collection('streams').doc('follow-1').set({
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: [followerId],
			object: [actor.id],
		});
		await db.collection('streams').doc('undo-1').set({
			id: 'https://remote.example/activities/undo-1',
			type: 'Undo',
			actor: [followerId],
			_meta: {collection: actor.inbox, objectType: 'Follow'},
		});

		expect(await getFollowers(actor)).toEqual([]);
	});

	test('keeps a follower who unfollowed and followed again', async () => {
		const followerId = 'https://remote.example/u/alice';
		await apex.store.saveObject({id: followerId, type: 'Person', preferredUsername: 'alice'});
		await db.collection('streams').doc('follow-1').set({
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: [followerId],
			object: [actor.id],
		});
		await db.collection('streams').doc('undo-1').set({
			id: 'https://remote.example/activities/undo-1',
			type: 'Undo',
			actor: [followerId],
			_meta: {collection: actor.inbox, objectType: 'Follow'},
		});
		await db.collection('streams').doc('follow-2').set({
			id: 'https://remote.example/activities/follow-2',
			type: 'Follow',
			actor: [followerId],
			object: [actor.id],
		});

		const followers = await getFollowers(actor);
		expect(followers).toHaveLength(1);
		expect(followers[0].acct).toBe('alice@remote.example');
	});

	test('does not count a Follow directed at a different actor', async () => {
		const followerId = 'https://remote.example/u/alice';
		const otherActorId = 'https://example.com/activitypub/u/someoneelse';
		await apex.store.saveObject({id: followerId, type: 'Person', preferredUsername: 'alice'});
		await db.collection('streams').doc('follow-1').set({
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: [followerId],
			object: [otherActorId],
		});

		expect(await getFollowers(actor)).toEqual([]);
	});
});
