import type { Request, Response } from 'express';
import { describe, expect, test } from 'vitest';
import { apex } from '../../src/apex.js';
import { denormalizeUndoObject, insertUndoDenormalization } from '../../src/inboxUndo.js';

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

describe('denormalizeUndoObject', () => {
	test('embeds resolved object when activity is Undo and res.locals.apex.object is set', async () => {
		const resolvedFollow = {
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: ['https://remote.example/u/alice'],
			object: ['https://example.com/activitypub/u/hakatashi'],
		};
		const resLocal: Record<string, unknown> = {
			activity: true,
			object: resolvedFollow,
		};
		const req = makeReq({
			id: 'https://remote.example/activities/undo-1',
			type: 'Undo',
			actor: 'https://remote.example/u/alice',
			object: 'https://remote.example/activities/follow-1',
		});
		const res = makeRes(resLocal);

		await runMiddleware(denormalizeUndoObject, req, res);

		expect(req.body.object).toEqual([resolvedFollow]);
	});

	test('embeds resolved object when type is an array containing Undo', async () => {
		const resolvedFollow = {
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
			actor: ['https://remote.example/u/alice'],
			object: ['https://example.com/activitypub/u/hakatashi'],
		};
		const resLocal: Record<string, unknown> = {
			activity: true,
			object: resolvedFollow,
		};
		const req = makeReq({
			id: 'https://remote.example/activities/undo-1',
			type: ['Undo'],
			actor: 'https://remote.example/u/alice',
			object: 'https://remote.example/activities/follow-1',
		});
		const res = makeRes(resLocal);

		await runMiddleware(denormalizeUndoObject, req, res);

		expect(req.body.object).toEqual([resolvedFollow]);
	});

	test('does not modify object when res.locals.apex.object is not set', async () => {
		const resLocal: Record<string, unknown> = {
			activity: true,
			object: undefined,
		};
		const req = makeReq({
			id: 'https://remote.example/activities/undo-1',
			type: 'Undo',
			actor: 'https://remote.example/u/alice',
			object: 'https://remote.example/activities/follow-unknown',
		});
		const res = makeRes(resLocal);

		await runMiddleware(denormalizeUndoObject, req, res);

		expect(req.body.object).toBe('https://remote.example/activities/follow-unknown');
	});

	test('does not modify object for non-Undo activities', async () => {
		const resolvedObject = {
			id: 'https://remote.example/objects/note-1',
			type: 'Note',
		};
		const resLocal: Record<string, unknown> = {
			activity: true,
			object: resolvedObject,
		};
		const req = makeReq({
			id: 'https://remote.example/activities/create-1',
			type: 'Create',
			object: 'https://remote.example/objects/note-1',
		});
		const res = makeRes(resLocal);

		await runMiddleware(denormalizeUndoObject, req, res);

		expect(req.body.object).toBe('https://remote.example/objects/note-1');
	});

	test('does not modify object when res.locals.apex.activity is false', async () => {
		const resolvedFollow = {
			id: 'https://remote.example/activities/follow-1',
			type: 'Follow',
		};
		const resLocal: Record<string, unknown> = {
			activity: false,
			object: resolvedFollow,
		};
		const req = makeReq({
			id: 'https://remote.example/activities/undo-1',
			type: 'Undo',
			object: 'https://remote.example/activities/follow-1',
		});
		const res = makeRes(resLocal);

		await runMiddleware(denormalizeUndoObject, req, res);

		expect(req.body.object).toBe('https://remote.example/activities/follow-1');
	});
});

describe('insertUndoDenormalization', () => {
	test('inserts denormalizeUndoObject immediately before apex.net.activity.save', () => {
		const chain = insertUndoDenormalization(apex.net.inbox.post);
		const saveIndex = chain.indexOf(apex.net.activity.save);
		expect(saveIndex).toBeGreaterThan(0);
		expect(chain[saveIndex - 1]).toBe(denormalizeUndoObject);
	});
});
