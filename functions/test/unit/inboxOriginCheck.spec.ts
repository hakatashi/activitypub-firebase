import type { Request, Response } from 'express';
import { describe, expect, test } from 'vitest';
import { verifySameOriginForUpdateDelete } from '../../src/inboxOriginCheck.js';

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

describe('verifySameOriginForUpdateDelete', () => {
	test('skips when res.locals.apex.actor is not set', async () => {
		const resLocal: Record<string, unknown> = { activity: true };
		const req = makeReq({ type: 'Delete', object: { id: 'https://evil.example/o/1' } });
		const res = makeRes(resLocal);

		await runMiddleware(verifySameOriginForUpdateDelete, req, res);

		expect(resLocal.activity).toBe(true);
		expect(resLocal.status).toBeUndefined();
	});

	test('skips activity types other than Update/Delete', async () => {
		const resLocal: Record<string, unknown> = {
			activity: true,
			actor: { id: 'https://evil.example/u/mallory' },
			object: { id: 'https://hakatashi.example/o/1' },
		};
		const req = makeReq({ type: 'Create', object: { id: 'https://hakatashi.example/o/1' } });
		const res = makeRes(resLocal);

		await runMiddleware(verifySameOriginForUpdateDelete, req, res);

		expect(resLocal.activity).toBe(true);
		expect(resLocal.status).toBeUndefined();
	});

	test('skips when there is no object to compare against (e.g. Delete of an unknown object)', async () => {
		const resLocal: Record<string, unknown> = {
			activity: true,
			actor: { id: 'https://evil.example/u/mallory' },
			object: undefined,
		};
		const req = makeReq({ type: 'Delete', object: 'https://hakatashi.example/o/1' });
		const res = makeRes(resLocal);

		await runMiddleware(verifySameOriginForUpdateDelete, req, res);

		expect(resLocal.activity).toBe(true);
		expect(resLocal.status).toBeUndefined();
	});

	test('rejects Delete when the actor origin does not match the object origin', async () => {
		const resLocal: Record<string, unknown> = {
			activity: true,
			actor: { id: 'https://evil.example/u/mallory' },
			object: { id: 'https://hakatashi.example/o/1', type: 'Note' },
		};
		const req = makeReq({ type: 'Delete', actor: 'https://evil.example/u/mallory' });
		const res = makeRes(resLocal);

		await runMiddleware(verifySameOriginForUpdateDelete, req, res);

		expect(resLocal.activity).toBe(false);
		expect(resLocal.status).toBe(403);
	});

	test('rejects Update where the inline object claims ownership matching the actor but targets a foreign id', async () => {
		// evil.example が attributedTo を自分自身の actor id に合わせても、
		// object.id のオリジンが actor と異なれば拒否される
		const resLocal: Record<string, unknown> = {
			activity: true,
			actor: { id: 'https://evil.example/u/mallory' },
			object: {
				id: 'https://hakatashi.example/o/1',
				type: 'Note',
				attributedTo: ['https://evil.example/u/mallory'],
			},
		};
		const req = makeReq({ type: 'Update', actor: 'https://evil.example/u/mallory' });
		const res = makeRes(resLocal);

		await runMiddleware(verifySameOriginForUpdateDelete, req, res);

		expect(resLocal.activity).toBe(false);
		expect(resLocal.status).toBe(403);
	});

	test('allows Update/Delete when actor and object share the same origin', async () => {
		const resLocal: Record<string, unknown> = {
			activity: true,
			actor: { id: 'https://remote.example/u/alice' },
			object: { id: 'https://remote.example/o/1', type: 'Note' },
		};
		const req = makeReq({ type: 'Update', actor: 'https://remote.example/u/alice' });
		const res = makeRes(resLocal);

		await runMiddleware(verifySameOriginForUpdateDelete, req, res);

		expect(resLocal.activity).toBe(true);
		expect(resLocal.status).toBeUndefined();
	});
});
