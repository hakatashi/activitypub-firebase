import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';
import type { APObject } from '../../../src/apex/types.js';

describe('apex pub/federation resolveReferences (ADR-0055)', () => {
	const DOMAIN = 'example.com';

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
		}) as IApexStore;

	const createApex = (
		options: {
			threadDepth?: number;
			threadLimit?: number;
			threadConcurrency?: number;
		} = {},
	) =>
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
				shares: '/s/:id/shares',
				likes: '/s/:id/likes',
			},
			store: createMockStore(),
			...options,
		});

	test('detects mutual circular references and terminates recursion without duplicate resolution', async () => {
		const apex = createApex({ threadDepth: 5 });
		const fakes: Record<string, APObject> = {
			'https://remote.example/s/1': {
				id: 'https://remote.example/s/1',
				type: 'Note',
				inReplyTo: 'https://remote.example/s/2',
			},
			'https://remote.example/s/2': {
				id: 'https://remote.example/s/2',
				type: 'Note',
				inReplyTo: 'https://remote.example/s/1',
			},
		};
		const requestSpy = vi
			.spyOn(apex, 'requestObject')
			.mockImplementation((id: string) => Promise.resolve(fakes[id]));

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			inReplyTo: ['https://remote.example/s/1'],
		});

		expect(result).toHaveLength(2);
		expect(result.map((r) => r.id)).toEqual([
			'https://remote.example/s/1',
			'https://remote.example/s/2',
		]);
		expect(requestSpy).toHaveBeenCalledTimes(2);
	});

	test('detects self-referencing links and does not resolve them repeatedly', async () => {
		const apex = createApex({ threadDepth: 5 });
		const fakes: Record<string, APObject> = {
			'https://remote.example/s/self': {
				id: 'https://remote.example/s/self',
				type: 'Note',
				inReplyTo: 'https://remote.example/s/self',
			},
		};
		const requestSpy = vi
			.spyOn(apex, 'requestObject')
			.mockImplementation((id: string) => Promise.resolve(fakes[id]));

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			inReplyTo: ['https://remote.example/s/self'],
		});

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('https://remote.example/s/self');
		expect(requestSpy).toHaveBeenCalledTimes(1);
	});

	test('deduplicates diamond references so shared ancestor is resolved only once', async () => {
		const apex = createApex({ threadDepth: 5 });
		const fakes: Record<string, APObject> = {
			'https://remote.example/s/b': {
				id: 'https://remote.example/s/b',
				type: 'Note',
				inReplyTo: 'https://remote.example/s/d',
			},
			'https://remote.example/s/c': {
				id: 'https://remote.example/s/c',
				type: 'Note',
				inReplyTo: 'https://remote.example/s/d',
			},
			'https://remote.example/s/d': {
				id: 'https://remote.example/s/d',
				type: 'Note',
			},
		};
		const requestSpy = vi
			.spyOn(apex, 'requestObject')
			.mockImplementation((id: string) => Promise.resolve(fakes[id]));

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			inReplyTo: ['https://remote.example/s/b', 'https://remote.example/s/c'],
		});

		expect(result).toHaveLength(3);
		expect(requestSpy).toHaveBeenCalledTimes(3);
		expect(result.map((r) => r.id).sort()).toEqual([
			'https://remote.example/s/b',
			'https://remote.example/s/c',
			'https://remote.example/s/d',
		]);
	});

	test('does not re-resolve root activity if child references root id', async () => {
		const apex = createApex({ threadDepth: 5 });
		const rootId = 'https://remote.example/s/root';
		const fakes: Record<string, APObject> = {
			'https://remote.example/s/child': {
				id: 'https://remote.example/s/child',
				type: 'Note',
				inReplyTo: rootId,
			},
		};
		const requestSpy = vi
			.spyOn(apex, 'requestObject')
			.mockImplementation((id: string) => Promise.resolve(fakes[id]));

		const result = await apex.resolveReferences({
			id: rootId,
			type: 'Create',
			object: ['https://remote.example/s/child'],
		});

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('https://remote.example/s/child');
		expect(requestSpy).toHaveBeenCalledTimes(1);
		expect(requestSpy).toHaveBeenCalledWith('https://remote.example/s/child');
	});

	test('strictly limits total resolved references using threadLimit', async () => {
		const apex = createApex({ threadLimit: 3, threadDepth: 10 });
		const fakes: Record<string, APObject> = {};
		for (let i = 1; i <= 10; i++) {
			fakes[`https://remote.example/s/${i}`] = {
				id: `https://remote.example/s/${i}`,
				type: 'Note',
				inReplyTo: `https://remote.example/s/${i + 1}`,
			};
		}
		const requestSpy = vi
			.spyOn(apex, 'requestObject')
			.mockImplementation((id: string) => Promise.resolve(fakes[id]));

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			inReplyTo: ['https://remote.example/s/1'],
		});

		expect(result).toHaveLength(3);
		expect(result.map((r) => r.id)).toEqual([
			'https://remote.example/s/1',
			'https://remote.example/s/2',
			'https://remote.example/s/3',
		]);
		expect(requestSpy).toHaveBeenCalledTimes(3);
	});

	test('limits recursion depth using threadDepth', async () => {
		const apex = createApex({ threadDepth: 2, threadLimit: 10 });
		const fakes: Record<string, APObject> = {};
		for (let i = 1; i <= 5; i++) {
			fakes[`https://remote.example/s/${i}`] = {
				id: `https://remote.example/s/${i}`,
				type: 'Note',
				inReplyTo: `https://remote.example/s/${i + 1}`,
			};
		}
		const requestSpy = vi
			.spyOn(apex, 'requestObject')
			.mockImplementation((id: string) => Promise.resolve(fakes[id]));

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			inReplyTo: ['https://remote.example/s/1'],
		});

		// depth 0: s/1, depth 1: s/2, depth 2: s/3. Stops at depth 2.
		expect(result).toHaveLength(3);
		expect(result.map((r) => r.id)).toEqual([
			'https://remote.example/s/1',
			'https://remote.example/s/2',
			'https://remote.example/s/3',
		]);
		expect(requestSpy).toHaveBeenCalledTimes(3);
	});

	test('skips Hashtags and does not attempt to fetch them over network', async () => {
		const apex = createApex();
		const requestSpy = vi.spyOn(apex, 'requestObject').mockResolvedValue(undefined);

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			tag: [
				{
					type: 'Hashtag',
					href: 'https://remote.example/tags/activitypub',
					name: '#activitypub',
				},
				{
					type: ['Hashtag'],
					href: 'https://remote.example/tags/mastodon',
					name: '#mastodon',
				},
			],
		});

		expect(result).toEqual([]);
		expect(requestSpy).not.toHaveBeenCalled();
	});

	test('resolves Mention tags at depth 0 but does not recurse into tag at depth > 0', async () => {
		const apex = createApex({ threadDepth: 5 });
		const fakes: Record<string, APObject> = {
			'https://remote.example/u/alice': {
				id: 'https://remote.example/u/alice',
				type: 'Person',
			},
			'https://remote.example/s/parent': {
				id: 'https://remote.example/s/parent',
				type: 'Note',
				tag: [
					{
						type: 'Mention',
						href: 'https://remote.example/u/bob',
					},
				],
			},
			'https://remote.example/u/bob': {
				id: 'https://remote.example/u/bob',
				type: 'Person',
			},
		};
		const requestSpy = vi
			.spyOn(apex, 'requestObject')
			.mockImplementation((id: string) => Promise.resolve(fakes[id]));

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			inReplyTo: ['https://remote.example/s/parent'],
			tag: [
				{
					type: 'Mention',
					href: 'https://remote.example/u/alice',
				},
			],
		});

		// At depth 0: s/parent and u/alice are resolved
		// At depth 1: s/parent has no inReplyTo/object/target; tag on s/parent (u/bob) is ignored!
		expect(result).toHaveLength(2);
		expect(result.map((r) => r.id)).toEqual([
			'https://remote.example/s/parent',
			'https://remote.example/u/alice',
		]);
		expect(requestSpy).toHaveBeenCalledTimes(2);
		expect(requestSpy).not.toHaveBeenCalledWith('https://remote.example/u/bob');
	});

	test('respects threadConcurrency by limiting in-flight requests', async () => {
		const apex = createApex({ threadConcurrency: 2, threadLimit: 10 });
		let activeRequests = 0;
		let maxConcurrent = 0;

		vi.spyOn(apex, 'requestObject').mockImplementation(async (id: string) => {
			activeRequests++;
			maxConcurrent = Math.max(maxConcurrent, activeRequests);
			// yield event loop to let concurrent tasks run
			await new Promise<void>((resolve) => {
				setTimeout(resolve, 10);
			});
			activeRequests--;
			return {
				id,
				type: 'Note',
			};
		});

		const result = await apex.resolveReferences({
			id: 'https://remote.example/activity/root',
			type: 'Create',
			tag: [
				{ href: 'https://remote.example/t/1' },
				{ href: 'https://remote.example/t/2' },
				{ href: 'https://remote.example/t/3' },
				{ href: 'https://remote.example/t/4' },
				{ href: 'https://remote.example/t/5' },
			],
		});

		expect(result).toHaveLength(5);
		expect(maxConcurrent).toBeLessThanOrEqual(2);
	});
});
