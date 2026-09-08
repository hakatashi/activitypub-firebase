import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

describe('apex validateOwner and same-origin validation (ADR-0046)', () => {
	const mockStore = {} as IApexStore;

	const apex = ActivitypubExpress({
		name: 'test-apex',
		version: '1.0.0',
		domain: 'example.com',
		actorParam: 'actor',
		objectParam: 'id',
		activityParam: 'id',
		routes: {
			actor: '/u/:actor',
			object: '/o/:id',
			activity: '/s/:id',
			inbox: '/u/:actor/inbox',
			outbox: '/u/:actor/outbox',
			followers: '/u/:actor/followers',
			following: '/u/:actor/following',
			liked: '/u/:actor/liked',
			collections: '/u/:actor/c/:id',
			blocked: '/u/:actor/blocked',
			rejections: '/u/:actor/rejections',
			rejected: '/u/:actor/rejected',
			shares: '/s/:id/shares',
			likes: '/s/:id/likes',
		},
		logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
		store: mockStore,
		offlineMode: false,
	});

	describe('originOf and isSameOrigin', () => {
		test('correctly extracts origin from valid URLs', () => {
			expect(apex.originOf('https://remote.example/u/alice')).toBe('https://remote.example');
			expect(apex.originOf('https://remote.example:8443/o/note-1')).toBe(
				'https://remote.example:8443',
			);
			expect(apex.originOf('http://localhost:3000/activitypub/u/user')).toBe(
				'http://localhost:3000',
			);
		});

		test('returns undefined for invalid URLs or non-string inputs', () => {
			expect(apex.originOf('not-a-url')).toBeUndefined();
			expect(apex.originOf(null)).toBeUndefined();
			expect(apex.originOf(undefined)).toBeUndefined();
			expect(apex.originOf(123)).toBeUndefined();
			expect(apex.originOf({})).toBeUndefined();
		});

		test('isSameOrigin returns true for matching origins', () => {
			expect(
				apex.isSameOrigin('https://remote.example/u/alice', 'https://remote.example/o/note-1'),
			).toBe(true);
			expect(
				apex.isSameOrigin('http://localhost:3000/u/alice', 'http://localhost:3000/inbox'),
			).toBe(true);
		});

		test('isSameOrigin returns false for differing origins or invalid inputs', () => {
			expect(
				apex.isSameOrigin('https://remote.example/u/alice', 'https://victim.example/o/note-1'),
			).toBe(false);
			expect(
				apex.isSameOrigin('http://remote.example/u/alice', 'https://remote.example/u/alice'),
			).toBe(false);
			expect(
				apex.isSameOrigin('https://remote.example:8080/u/alice', 'https://remote.example/u/alice'),
			).toBe(false);
			expect(apex.isSameOrigin('not-a-url', 'https://remote.example/u/alice')).toBe(false);
			expect(apex.isSameOrigin(null, 'https://remote.example/u/alice')).toBe(false);
		});
	});

	describe('validateOwner', () => {
		const ACTOR_ID = 'https://remote.example/u/alice';
		const actor = {
			id: ACTOR_ID,
			type: 'Person',
			followers: ['https://remote.example/u/alice/followers'],
			following: ['https://remote.example/u/alice/following'],
			inbox: ['https://remote.example/u/alice/inbox'],
			outbox: ['https://remote.example/u/alice/outbox'],
			streams: [{ custom: 'https://remote.example/u/alice/c/custom' }],
		};

		test('returns true when object is the actor itself', () => {
			const selfObject = { id: ACTOR_ID, type: 'Person' };
			expect(apex.validateOwner(selfObject, actor)).toBe(true);
		});

		test('returns true when object.attributedTo matches actor.id on the same origin', () => {
			const note = {
				id: 'https://remote.example/o/note-1',
				type: 'Note',
				attributedTo: [ACTOR_ID],
			};
			expect(apex.validateOwner(note, actor)).toBe(true);
		});

		test('returns true when object.actor matches actor.id on the same origin', () => {
			const activity = {
				id: 'https://remote.example/s/activity-1',
				type: 'Create',
				actor: [ACTOR_ID],
			};
			expect(apex.validateOwner(activity, actor)).toBe(true);
		});

		test('returns true for standard actor collections on the same origin', () => {
			const followers = {
				id: 'https://remote.example/u/alice/followers',
				type: 'OrderedCollection',
			};
			expect(apex.validateOwner(followers, actor)).toBe(true);
		});

		test('returns true for custom actor collections in actor.streams', () => {
			const customCollection = {
				id: 'https://remote.example/u/alice/c/custom',
				type: 'Collection',
			};
			expect(apex.validateOwner(customCollection, actor)).toBe(true);
		});

		test('handles object or actor wrapped in array', () => {
			const note = {
				id: 'https://remote.example/o/note-1',
				type: 'Note',
				attributedTo: [ACTOR_ID],
			};
			expect(apex.validateOwner([note], actor)).toBe(true);
			expect(apex.validateOwner(note, [actor])).toBe(true);
		});

		test('rejects when object.attributedTo matches actor.id but object.id is on a different origin (spoofing)', () => {
			const foreignNote = {
				id: 'https://victim.example/o/note-1',
				type: 'Note',
				attributedTo: [ACTOR_ID],
			};
			expect(apex.validateOwner(foreignNote, actor)).toBe(false);
		});

		test('rejects when object.actor matches actor.id but object.id is on a different origin', () => {
			const foreignActivity = {
				id: 'https://victim.example/s/activity-1',
				type: 'Create',
				actor: [ACTOR_ID],
			};
			expect(apex.validateOwner(foreignActivity, actor)).toBe(false);
		});

		test('rejects when object is a collection on a foreign origin even if in streams', () => {
			const actorWithForeignStream = {
				id: ACTOR_ID,
				type: 'Person',
				streams: [{ custom: 'https://victim.example/u/victim/c/custom' }],
			};
			const foreignCollection = {
				id: 'https://victim.example/u/victim/c/custom',
				type: 'Collection',
			};
			expect(apex.validateOwner(foreignCollection, actorWithForeignStream)).toBe(false);
		});

		test('rejects when object is owned by someone else on the same origin', () => {
			const otherNote = {
				id: 'https://remote.example/o/note-2',
				type: 'Note',
				attributedTo: ['https://remote.example/u/bob'],
			};
			expect(apex.validateOwner(otherNote, actor)).toBe(false);
		});

		test('rejects when object or actor is missing or invalid', () => {
			expect(apex.validateOwner(null, actor)).toBe(false);
			expect(apex.validateOwner(undefined, actor)).toBe(false);
			expect(apex.validateOwner('https://remote.example/o/1', actor)).toBe(false);
			expect(apex.validateOwner({}, actor)).toBe(false);
			expect(apex.validateOwner({ id: 'https://remote.example/o/1' }, actor)).toBe(false);
			expect(apex.validateOwner({ id: 'https://remote.example/o/1', type: 'Note' }, null)).toBe(
				false,
			);
			expect(
				apex.validateOwner({ id: 'https://remote.example/o/1', type: 'Note' }, undefined),
			).toBe(false);
			expect(apex.validateOwner({ id: 'https://remote.example/o/1', type: 'Note' }, {})).toBe(
				false,
			);
		});
	});
});
