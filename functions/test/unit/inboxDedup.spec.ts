import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { correctIsNewActivity, markRedundantInboxDelivery } from '../../src/inboxDedup.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const makeReq = (body: unknown) => ({ body }) as unknown as Request;
const makeRes = (locals: Record<string, unknown>) =>
	({ locals: { apex: locals } }) as unknown as Response;

const runMiddleware = (
	middleware: (req: Request, res: Response, next: (err?: unknown) => void) => void,
	req: Request,
	res: Response,
) =>
	new Promise<void>((resolve, reject) => {
		middleware(req, res, (err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});

describe('inboxDedup', () => {
	beforeEach(() => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{ method: 'DELETE' },
		);
	});

	describe('markRedundantInboxDelivery', () => {
		test('skips when res.locals.apex.activity/target are not set', async () => {
			const resLocal: Record<string, unknown> = {};
			const req = makeReq({ id: 'https://remote.example/activities/1' });
			const res = makeRes(resLocal);

			await runMiddleware(markRedundantInboxDelivery, req, res);

			expect(resLocal.isRedundantDelivery).toBeUndefined();
		});

		test('marks redundant when the target is already in the stored _meta.collection', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/activities/1',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/activitypub/u/hakatashi'],
				_meta: { collection: ['https://example.com/activitypub/u/hakatashi/inbox'] },
			});

			const resLocal: Record<string, unknown> = {
				activity: true,
				target: { id: 'https://example.com/activitypub/u/hakatashi' },
			};
			const req = makeReq({
				id: 'https://remote.example/activities/1',
				_meta: { collection: ['https://example.com/activitypub/u/hakatashi/inbox'] },
			});
			const res = makeRes(resLocal);

			await runMiddleware(markRedundantInboxDelivery, req, res);

			expect(resLocal.isRedundantDelivery).toBe(true);
		});

		test('does not mark redundant when the target is a new collection', async () => {
			await apex.store.saveActivity({
				id: 'https://remote.example/activities/2',
				type: 'Follow',
				actor: ['https://remote.example/u/alice'],
				object: ['https://example.com/activitypub/u/hakatashi'],
				_meta: { collection: ['https://example.com/activitypub/u/other/inbox'] },
			});

			const resLocal: Record<string, unknown> = {
				activity: true,
				target: { id: 'https://example.com/activitypub/u/hakatashi' },
			};
			const req = makeReq({
				id: 'https://remote.example/activities/2',
				_meta: { collection: ['https://example.com/activitypub/u/hakatashi/inbox'] },
			});
			const res = makeRes(resLocal);

			await runMiddleware(markRedundantInboxDelivery, req, res);

			expect(resLocal.isRedundantDelivery).toBe(false);
		});
	});

	describe('correctIsNewActivity', () => {
		test('corrects isNewActivity to false when the delivery was redundant', async () => {
			const resLocal: Record<string, unknown> = {
				isRedundantDelivery: true,
				isNewActivity: 'new collection',
			};
			const req = makeReq({});
			const res = makeRes(resLocal);

			await runMiddleware(correctIsNewActivity, req, res);

			expect(resLocal.isNewActivity).toBe(false);
		});

		test('leaves isNewActivity untouched for a genuinely new collection', async () => {
			const resLocal: Record<string, unknown> = {
				isRedundantDelivery: false,
				isNewActivity: 'new collection',
			};
			const req = makeReq({});
			const res = makeRes(resLocal);

			await runMiddleware(correctIsNewActivity, req, res);

			expect(resLocal.isNewActivity).toBe('new collection');
		});

		test('leaves isNewActivity untouched when it was already true (first delivery)', async () => {
			const resLocal: Record<string, unknown> = {
				isRedundantDelivery: false,
				isNewActivity: true,
			};
			const req = makeReq({});
			const res = makeRes(resLocal);

			await runMiddleware(correctIsNewActivity, req, res);

			expect(resLocal.isNewActivity).toBe(true);
		});
	});
});
