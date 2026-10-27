import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import { PermanentFetchError, TransientFetchError } from '../../../src/apex/pub/fetchErrors.js';
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
		preferredUsername: ['bob'],
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
		getObjects: vi.fn().mockResolvedValue([]),
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
		deliveryDequeue: vi.fn().mockResolvedValue(null),
		getUserCount: vi.fn().mockResolvedValue(0),
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

		test('resolves target Follow activity by collection and actorId for Undo activity when getActivity returns undefined (ADR-0123)', async () => {
			const existingFollow = {
				id: 'https://remote.example/follows/request-1',
				type: 'Follow',
				actor: [ACTOR_ID],
				object: [RECIPIENT_ID],
			};
			const undoActivity = {
				id: 'https://remote.example/follows/alice/bob/undo',
				type: 'Undo',
				actor: [ACTOR_ID],
				object: [
					{
						id: 'https://remote.example/follows/alice/bob',
						type: 'Follow',
						actor: [ACTOR_ID],
						object: [RECIPIENT_ID],
					},
				],
			};

			vi.mocked(mockStore.getActivity).mockResolvedValueOnce(undefined);
			vi.mocked(mockStore.findActivityByCollectionAndActorId).mockResolvedValueOnce(existingFollow);

			const { req, res } = createMockReqRes(undoActivity, {
				target: {
					...recipient,
					followers: [`${RECIPIENT_ID}/followers`],
				},
				actor,
			});
			await runMiddleware(apex.net.validators.activityObject, req, res);

			expect(mockStore.getActivity).toHaveBeenCalledWith(
				'https://remote.example/follows/alice/bob',
				true,
			);
			expect(mockStore.findActivityByCollectionAndActorId).toHaveBeenCalledWith(
				`${RECIPIENT_ID}/followers`,
				ACTOR_ID,
				true,
			);
			expect(res.locals.apex.object).toEqual(existingFollow);
		});
		test('looks up a plain object for Add without fetching it (ADR-0144)', async () => {
			const resolveActivitySpy = vi.spyOn(apex, 'resolveActivity');
			const addActivity = {
				id: 'https://remote.example/s/add-1',
				type: 'Add',
				actor: [ACTOR_ID],
				object: [NOTE_ID],
				target: [`${ACTOR_ID}/featured`],
			};

			const { req, res } = createMockReqRes(addActivity);
			await runMiddleware(apex.net.validators.activityObject, req, res);

			expect(res.locals.apex.object).toEqual(note);
			expect(resolveActivitySpy).not.toHaveBeenCalled();
			resolveActivitySpy.mockRestore();
		});

		test('leaves the object undefined for Remove of an unknown object', async () => {
			const removeActivity = {
				id: 'https://remote.example/s/remove-1',
				type: 'Remove',
				actor: [ACTOR_ID],
				object: ['https://remote.example/o/unknown'],
				target: [`${ACTOR_ID}/featured`],
			};

			const { req, res } = createMockReqRes(removeActivity);
			await runMiddleware(apex.net.validators.activityObject, req, res);

			expect(res.locals.apex.object).toBeUndefined();
		});

		test('sets status 200 and ignores activity when resolving object fails with PermanentFetchError (ADR-0158)', async () => {
			const announceActivity = {
				id: 'https://remote.example/s/announce-1',
				type: 'Announce',
				actor: [ACTOR_ID],
				object: ['https://third-party.example/notes/401'],
			};

			const resolveObjectSpy = vi
				.spyOn(apex, 'resolveObject')
				.mockRejectedValueOnce(new PermanentFetchError('Request failed with status code 401', 401));

			const { req, res } = createMockReqRes(announceActivity);
			await runMiddleware(apex.net.validators.activityObject, req, res);

			expect(res.locals.apex.status).toBe(200);
			expect(res.locals.apex.object).toBeUndefined();
			expect(apex.logger.warn).toHaveBeenCalledWith(
				'Failed to resolve activity object permanently, ignoring activity:',
				expect.stringContaining('401'),
			);

			resolveObjectSpy.mockRestore();
		});

		test('propagates error when resolving object fails with TransientFetchError (ADR-0115)', async () => {
			const announceActivity = {
				id: 'https://remote.example/s/announce-1',
				type: 'Announce',
				actor: [ACTOR_ID],
				object: ['https://third-party.example/notes/500'],
			};

			const transientError = new TransientFetchError('Request failed with status code 500');
			const resolveObjectSpy = vi
				.spyOn(apex, 'resolveObject')
				.mockRejectedValueOnce(transientError);

			const { req, res } = createMockReqRes(announceActivity);
			await expect(runMiddleware(apex.net.validators.activityObject, req, res)).rejects.toThrow(
				transientError,
			);

			expect(res.locals.apex.status).toBeUndefined();

			resolveObjectSpy.mockRestore();
		});

		test('propagates unexpected non-fetch errors (e.g. database error) without setting status 200', async () => {
			const announceActivity = {
				id: 'https://remote.example/s/announce-1',
				type: 'Announce',
				actor: [ACTOR_ID],
				object: ['https://third-party.example/notes/db-err'],
			};

			const dbError = new Error('Firestore transaction aborted');
			const resolveObjectSpy = vi.spyOn(apex, 'resolveObject').mockRejectedValueOnce(dbError);

			const { req, res } = createMockReqRes(announceActivity);
			await expect(runMiddleware(apex.net.validators.activityObject, req, res)).rejects.toThrow(
				dbError,
			);

			expect(res.locals.apex.status).toBeUndefined();

			resolveObjectSpy.mockRestore();
		});

		test('skips object resolution when status is already set', async () => {
			const announceActivity = {
				id: 'https://remote.example/s/announce-1',
				type: 'Announce',
				actor: [ACTOR_ID],
				object: ['https://third-party.example/notes/1'],
			};

			const resolveObjectSpy = vi.spyOn(apex, 'resolveObject');

			const { req, res } = createMockReqRes(announceActivity, { status: 200 });
			await runMiddleware(apex.net.validators.activityObject, req, res);

			expect(resolveObjectSpy).not.toHaveBeenCalled();
			expect(res.locals.apex.status).toBe(200);

			resolveObjectSpy.mockRestore();
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
		test.each(['Add', 'Remove'])(
			'accepts %s whose object is not an Activity (ADR-0144)',
			async (type) => {
				const activity = {
					id: `https://remote.example/s/${type}-1`,
					type,
					actor: [ACTOR_ID],
					object: ['https://remote.example/o/unknown'],
					target: [`${ACTOR_ID}/featured`],
				};

				const { req, res } = createMockReqRes(activity, {
					target: recipient,
					actor,
					object: undefined,
				});

				await runMiddleware(apex.net.validators.inboxActivity, req, res);

				expect(res.locals.apex.activity).toBe(true);
				expect(res.locals.apex.status).toBeUndefined();
			},
		);

		test('rejects Add without an object with 400', async () => {
			const addActivity = {
				id: 'https://remote.example/s/add-1',
				type: 'Add',
				actor: [ACTOR_ID],
				target: [`${ACTOR_ID}/featured`],
			};

			const { req, res } = createMockReqRes(addActivity, { target: recipient, actor });

			await runMiddleware(apex.net.validators.inboxActivity, req, res);

			expect(res.locals.apex.status).toBe(400);
			expect(res.locals.apex.activity).toBeUndefined();
		});

		test('skips validation and preserves status when status is already set to 200 (ADR-0158)', async () => {
			const announceActivity = {
				id: 'https://remote.example/s/announce-1',
				type: 'Announce',
				actor: [ACTOR_ID],
				object: ['https://third-party.example/notes/401'],
			};

			const { req, res } = createMockReqRes(announceActivity, {
				target: recipient,
				actor,
				object: undefined,
				status: 200,
			});

			await runMiddleware(apex.net.validators.inboxActivity, req, res);

			expect(res.locals.apex.status).toBe(200);
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

		test('resolves Note for Add activity and validates without requiring an Activity object in outbox', async () => {
			const targetCollection = `${RECIPIENT_ID}/c/featured-items`;
			const addActivity = {
				id: 'https://example.com/s/add-1',
				type: 'Add',
				actor: [RECIPIENT_ID],
				object: [NOTE_ID],
				target: [targetCollection],
			};

			const { req, res } = createMockReqRes(addActivity, {
				target: recipient,
			});

			await runMiddleware(apex.net.validators.outboxActivityObject, req, res);

			expect(res.locals.apex.object).toEqual(note);

			await runMiddleware(apex.net.validators.outboxActivity, req, res);

			expect(res.locals.apex.activity).toBe(true);
			expect(res.locals.apex.status).toBeUndefined();
		});

		test('rejects outbox Add without object with 400', async () => {
			const targetCollection = `${RECIPIENT_ID}/c/featured-items`;
			const addActivity = {
				id: 'https://example.com/s/add-1',
				type: 'Add',
				actor: [RECIPIENT_ID],
				target: [targetCollection],
			};

			const { req, res } = createMockReqRes(addActivity, {
				target: recipient,
			});

			await runMiddleware(apex.net.validators.outboxActivityObject, req, res);
			await runMiddleware(apex.net.validators.outboxActivity, req, res);

			expect(res.locals.apex.status).toBe(400);
			expect(res.locals.apex.statusMessage).toBe('Object requried for Add activity');
			expect(res.locals.apex.activity).toBeUndefined();
		});
	});
});
