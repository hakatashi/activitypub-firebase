import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

describe('apex validators for Like and Announce (ADR-0047)', () => {
	const NOTE_ID = 'https://example.com/o/note-1';
	const ACTOR_ID = 'https://remote.example/u/alice';
	const RECIPIENT_ID = 'https://example.com/u/bob';

	const note = {
		id: NOTE_ID,
		type: 'Note',
		attributedTo: [RECIPIENT_ID],
		content: ['Hello world'],
	};

	const recipient = {
		id: RECIPIENT_ID,
		type: 'Person',
		inbox: [`${RECIPIENT_ID}/inbox`],
		outbox: [`${RECIPIENT_ID}/outbox`],
	};

	const actor = {
		id: ACTOR_ID,
		type: 'Person',
		inbox: [`${ACTOR_ID}/inbox`],
		outbox: [`${ACTOR_ID}/outbox`],
	};

	const mockStore: IApexStore = {
		getObject: vi.fn().mockImplementation((id: string) => {
			if (id === NOTE_ID) {
				return Promise.resolve(note);
			}
			if (id === RECIPIENT_ID) {
				return Promise.resolve(recipient);
			}
			if (id === ACTOR_ID) {
				return Promise.resolve(actor);
			}
			return Promise.resolve(undefined);
		}),
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

	describe('activityObject (inbox)', () => {
		test('resolves Note targeting object for Like activity using store.getObject', async () => {
			const likeActivity = {
				id: 'https://remote.example/s/like-1',
				type: 'Like',
				actor: [ACTOR_ID],
				object: [NOTE_ID],
			};

			const { req, res } = createMockReqRes(likeActivity);
			await runMiddleware(apex.net.validators.activityObject, req, res);

			expect(res.locals.apex.object).toEqual(note);
			expect(mockStore.getObject).toHaveBeenCalledWith(NOTE_ID, true);
		});

		test('resolves Note targeting object for Announce activity using store.getObject', async () => {
			const announceActivity = {
				id: 'https://remote.example/s/announce-1',
				type: 'Announce',
				actor: [ACTOR_ID],
				object: [NOTE_ID],
			};

			const { req, res } = createMockReqRes(announceActivity);
			await runMiddleware(apex.net.validators.activityObject, req, res);

			expect(res.locals.apex.object).toEqual(note);
			expect(mockStore.getObject).toHaveBeenCalledWith(NOTE_ID, true);
		});
	});

	describe('inboxActivity', () => {
		test('accepts Like activity targeting a Note (plain object without actor property)', async () => {
			const likeActivity = {
				id: 'https://remote.example/s/like-1',
				type: 'Like',
				actor: [ACTOR_ID],
				object: [NOTE_ID],
			};

			const { req, res } = createMockReqRes(likeActivity, {
				target: recipient,
				actor,
				object: note,
			});

			await runMiddleware(apex.net.validators.inboxActivity, req, res);

			expect(res.locals.apex.activity).toBe(true);
			expect(res.locals.apex.status).toBeUndefined();
		});

		test('accepts Announce activity targeting a Note (plain object without actor property)', async () => {
			const announceActivity = {
				id: 'https://remote.example/s/announce-1',
				type: 'Announce',
				actor: [ACTOR_ID],
				object: [NOTE_ID],
			};

			const { req, res } = createMockReqRes(announceActivity, {
				target: recipient,
				actor,
				object: note,
			});

			await runMiddleware(apex.net.validators.inboxActivity, req, res);

			expect(res.locals.apex.activity).toBe(true);
			expect(res.locals.apex.status).toBeUndefined();
		});

		test('rejects Like activity with 400 when object is missing or invalid', async () => {
			const likeActivity = {
				id: 'https://remote.example/s/like-1',
				type: 'Like',
				actor: [ACTOR_ID],
				object: [NOTE_ID],
			};

			const { req, res } = createMockReqRes(likeActivity, {
				target: recipient,
				actor,
				object: undefined,
			});

			await runMiddleware(apex.net.validators.inboxActivity, req, res);

			expect(res.locals.apex.status).toBe(400);
			expect(res.locals.apex.statusMessage).toBe('Object requried for Like activity');
			expect(res.locals.apex.activity).toBeUndefined();
		});
	});

	describe('outboxActivityObject and outboxActivity', () => {
		test('resolves and validates Like activity targeting a Note in outbox', async () => {
			const likeActivity = {
				id: 'https://example.com/s/like-1',
				type: 'Like',
				actor: [RECIPIENT_ID],
				object: [NOTE_ID],
			};

			const { req, res } = createMockReqRes(likeActivity, {
				target: recipient,
			});

			await runMiddleware(apex.net.validators.outboxActivityObject, req, res);

			expect(res.locals.apex.object).toEqual(note);

			await runMiddleware(apex.net.validators.outboxActivity, req, res);

			expect(res.locals.apex.activity).toBe(true);
			expect(res.locals.apex.status).toBeUndefined();
		});

		test('resolves and validates Announce activity targeting a Note in outbox', async () => {
			const announceActivity = {
				id: 'https://example.com/s/announce-1',
				type: 'Announce',
				actor: [RECIPIENT_ID],
				object: [NOTE_ID],
			};

			const { req, res } = createMockReqRes(announceActivity, {
				target: recipient,
			});

			await runMiddleware(apex.net.validators.outboxActivityObject, req, res);

			expect(res.locals.apex.object).toEqual(note);

			await runMiddleware(apex.net.validators.outboxActivity, req, res);

			expect(res.locals.apex.activity).toBe(true);
			expect(res.locals.apex.status).toBeUndefined();
		});
	});
});
