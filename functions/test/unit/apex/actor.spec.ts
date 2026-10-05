import { beforeEach, describe, expect, it, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import { createActor } from '../../../src/apex/pub/actor.js';
import type IApexStore from '../../../src/apex/store/interface.js';
import type { APObject } from '../../../src/apex/types.js';
import { TEST_KEY_PAIRS } from '../../fixtures/keys.js';
import {
	getLastKeyGenCall,
	getMockKeyGenCallCount,
	resetMockKeyStats,
} from '../../helpers/mock-keys.js';

describe('createActor pregenerated test keys (ADR-0076)', () => {
	const DOMAIN = 'test.example.com';

	const createMockStore = () =>
		({
			getObject: vi.fn().mockResolvedValue(undefined),
			saveObject: vi.fn().mockResolvedValue(true),
			updateObject: vi.fn().mockResolvedValue(true),
			getActivity: vi.fn().mockResolvedValue(undefined),
			saveActivity: vi.fn().mockResolvedValue({ isNew: true, activity: {} }),
			updateActivity: vi.fn().mockResolvedValue(true),
			updateActivityMeta: vi.fn().mockResolvedValue(undefined),
			removeActivity: vi.fn().mockResolvedValue(undefined),
			generateId: vi.fn().mockReturnValue('generated-id'),
			getContext: vi.fn().mockResolvedValue(undefined),
			saveContext: vi.fn().mockResolvedValue(undefined),
			setup: vi.fn().mockResolvedValue(undefined),
			getStream: vi.fn().mockResolvedValue(undefined),
			getStreamCount: vi.fn().mockResolvedValue(0),
			deliveryEnqueue: vi.fn().mockResolvedValue(true),
			deliveryRequeue: vi.fn().mockResolvedValue(true),
			findActivityByCollectionAndObjectId: vi.fn().mockResolvedValue(undefined),
			findActivityByCollectionAndActorId: vi.fn().mockResolvedValue(undefined),
		}) as unknown as IApexStore;

	const createApex = () =>
		ActivitypubExpress({
			name: 'test-apex',
			version: '1.0.0',
			domain: DOMAIN,
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
				shares: '/u/:actor/shares',
				likes: '/u/:actor/likes',
			},
			store: createMockStore(),
		});

	const getPublicKeyPem = (act: APObject): string => {
		const rawKey = act.publicKey as unknown;
		if (Array.isArray(rawKey)) {
			const first = rawKey[0] as { publicKeyPem?: unknown };
			if (Array.isArray(first?.publicKeyPem)) {
				return String(first.publicKeyPem[0]);
			}
			return String(first?.publicKeyPem);
		}
		if (rawKey && typeof rawKey === 'object' && 'publicKeyPem' in rawKey) {
			return String((rawKey as { publicKeyPem: unknown }).publicKeyPem);
		}
		throw new Error('publicKeyPem not found on actor');
	};

	beforeEach(() => {
		resetMockKeyStats();
	});

	it('uses pregenerated test fixture keys and does not invoke slow RSA generation', async () => {
		const apex = createApex();
		const start = performance.now();
		const actor = await createActor.call(apex, 'alice', 'Alice', 'Bio for Alice');
		const duration = performance.now() - start;

		// Key generation should be nearly instantaneous (< 50ms vs > 300ms for RSA-4096)
		expect(duration).toBeLessThan(100);

		// Verified mock was called
		expect(getMockKeyGenCallCount()).toBe(1);

		// Verified actor has the first fixture key
		expect(getPublicKeyPem(actor)).toBe(TEST_KEY_PAIRS[0]!.publicKey);
		expect((actor._meta as { privateKey: string }).privateKey).toBe(TEST_KEY_PAIRS[0]!.privateKey);
	});

	it('rotates fixture keys across multiple actors to preserve key separation', async () => {
		const apex = createApex();
		const actor1 = await createActor.call(apex, 'user1', 'User 1', '');
		const actor2 = await createActor.call(apex, 'user2', 'User 2', '');
		const actor3 = await createActor.call(apex, 'user3', 'User 3', '');

		expect(getMockKeyGenCallCount()).toBe(3);

		const pub1 = getPublicKeyPem(actor1);
		const pub2 = getPublicKeyPem(actor2);
		const pub3 = getPublicKeyPem(actor3);

		expect(pub1).toBe(TEST_KEY_PAIRS[0]!.publicKey);
		expect(pub2).toBe(TEST_KEY_PAIRS[1]!.publicKey);
		expect(pub3).toBe(TEST_KEY_PAIRS[2]!.publicKey);

		// Distinct keys
		expect(pub1).not.toBe(pub2);
		expect(pub2).not.toBe(pub3);
		expect(pub1).not.toBe(pub3);
	});

	it('verifies that production createActor requests RSA-4096 with correct encoding', async () => {
		const apex = createApex();
		await createActor.call(apex, 'bob', 'Bob', '');

		const lastCall = getLastKeyGenCall();
		expect(lastCall.type).toBe('rsa');
		expect(lastCall.options).toEqual({
			modulusLength: 4096,
			publicKeyEncoding: {
				type: 'spki',
				format: 'pem',
			},
			privateKeyEncoding: {
				type: 'pkcs8',
				format: 'pem',
			},
		});
	});
});
