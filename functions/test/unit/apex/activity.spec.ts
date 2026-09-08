import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

describe('apex activity save (ADR-0048)', () => {
	const ACTOR_ID = 'https://remote.example/u/alice';
	const RECIPIENT_ID = 'https://example.com/u/bob';
	const FOLLOW_ID = 'https://remote.example/s/follow-1';
	const UNDO_ID = 'https://remote.example/s/undo-1';

	const recipient = {
		id: RECIPIENT_ID,
		type: 'Person',
		inbox: [`${RECIPIENT_ID}/inbox`],
		outbox: [`${RECIPIENT_ID}/outbox`],
	};

	const resolvedFollow = {
		id: FOLLOW_ID,
		type: 'Follow',
		actor: [ACTOR_ID],
		object: [RECIPIENT_ID],
	};

	const mockStore: IApexStore = {
		getObject: vi.fn().mockResolvedValue(undefined),
		saveObject: vi.fn().mockResolvedValue(true),
		updateObject: vi.fn().mockResolvedValue(true),
		getActivity: vi.fn().mockResolvedValue(undefined),
		saveActivity: vi.fn().mockResolvedValue(true),
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
	};

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
		offlineMode: true,
	});

	const createMockReqRes = (
		body: Record<string, unknown>,
		localsApex: Record<string, unknown> = {},
	) => {
		const req = {
			app: { locals: { apex } },
			body,
			params: { actor: 'bob' },
		} as unknown as Request;
		const res = {
			locals: {
				apex: {
					...localsApex,
				},
			},
		} as unknown as Response;
		return { req, res };
	};

	const runMiddleware = (middleware: RequestHandler, req: Request, res: Response) => {
		return new Promise<void>((resolve, reject) => {
			middleware(req, res, ((err?: unknown) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			}) as NextFunction);
		});
	};

	test('denormalizes object when saving Undo activity with resolved object in res.locals.apex.object', async () => {
		const undoActivity = {
			id: UNDO_ID,
			type: 'Undo',
			actor: [ACTOR_ID],
			object: [FOLLOW_ID],
		};

		const { req, res } = createMockReqRes(undoActivity, {
			activity: true,
			target: recipient,
			object: resolvedFollow,
		});

		await runMiddleware(apex.net.activity.save, req, res);

		expect(mockStore.saveActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				id: UNDO_ID,
				type: 'Undo',
				object: [resolvedFollow],
			}),
		);
	});

	test('does not denormalize object when res.locals.apex.object is not set', async () => {
		const undoActivity = {
			id: UNDO_ID,
			type: 'Undo',
			actor: [ACTOR_ID],
			object: [FOLLOW_ID],
		};

		const { req, res } = createMockReqRes(undoActivity, {
			activity: true,
			target: recipient,
			object: undefined,
		});

		await runMiddleware(apex.net.activity.save, req, res);

		expect(mockStore.saveActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				id: UNDO_ID,
				type: 'Undo',
				object: [FOLLOW_ID],
			}),
		);
	});

	test('skips saving when res.locals.apex.activity is false', async () => {
		const undoActivity = {
			id: UNDO_ID,
			type: 'Undo',
			actor: [ACTOR_ID],
			object: [FOLLOW_ID],
		};

		const { req, res } = createMockReqRes(undoActivity, {
			activity: false,
			target: recipient,
			object: resolvedFollow,
		});

		vi.clearAllMocks();
		await runMiddleware(apex.net.activity.save, req, res);

		expect(mockStore.saveActivity).not.toHaveBeenCalled();
	});
});
