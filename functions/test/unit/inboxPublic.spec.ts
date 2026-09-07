import type { Request, Response } from 'express';
import { describe, expect, test } from 'vitest';
import { normalizeInboxPublic, normalizePublicAddresses } from '../../src/inboxPublic.js';

const makeReq = (body: unknown) => ({ body }) as unknown as Request;
const makeRes = (locals: Record<string, unknown> = {}) =>
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

describe('inboxPublic', () => {
	describe('normalizePublicAddresses', () => {
		test('normalizes "Public" to "as:Public"', () => {
			const activity: Record<string, unknown> = {
				type: 'Create',
				to: ['Public'],
				cc: ['https://example.com/followers'],
			};
			normalizePublicAddresses(activity);
			expect(activity.to).toEqual(['as:Public']);
			expect(activity.cc).toEqual(['https://example.com/followers']);
		});

		test('normalizes full Public URI to "as:Public"', () => {
			const activity: Record<string, unknown> = {
				type: 'Create',
				to: 'https://www.w3.org/ns/activitystreams#Public',
			};
			normalizePublicAddresses(activity);
			expect(activity.to).toBe('as:Public');
		});

		test('leaves "as:Public" untouched', () => {
			const activity: Record<string, unknown> = {
				type: 'Create',
				to: ['as:Public'],
			};
			normalizePublicAddresses(activity);
			expect(activity.to).toEqual(['as:Public']);
		});

		test('normalizes nested object addressing', () => {
			const activity: Record<string, unknown> = {
				type: 'Create',
				to: ['Public'],
				object: {
					type: 'Note',
					to: ['https://www.w3.org/ns/activitystreams#Public'],
					cc: ['Public', 'https://example.com/followers'],
				},
			};
			normalizePublicAddresses(activity);
			expect(activity.to).toEqual(['as:Public']);
			const obj = activity.object as Record<string, unknown>;
			expect(obj.to).toEqual(['as:Public']);
			expect(obj.cc).toEqual(['as:Public', 'https://example.com/followers']);
		});

		test('normalizes array of nested objects', () => {
			const activity: Record<string, unknown> = {
				type: 'Create',
				object: [
					{
						type: 'Note',
						to: 'Public',
					},
					{
						type: 'Note',
						audience: ['Public'],
					},
				],
			};
			normalizePublicAddresses(activity);
			const objects = activity.object as Record<string, unknown>[];
			expect(objects[0].to).toBe('as:Public');
			expect(objects[1].audience).toEqual(['as:Public']);
		});

		test('handles null and primitives safely', () => {
			expect(() => normalizePublicAddresses(null)).not.toThrow();
			expect(() => normalizePublicAddresses(undefined)).not.toThrow();
			expect(() => normalizePublicAddresses('string')).not.toThrow();
		});
	});

	describe('normalizeInboxPublic middleware', () => {
		test('normalizes both req.body and res.locals.apex.object', async () => {
			const req = makeReq({
				type: 'Create',
				to: ['Public'],
			});
			const res = makeRes({
				object: {
					type: 'Note',
					to: ['Public'],
				},
			});

			await runMiddleware(normalizeInboxPublic, req, res);

			expect((req.body as Record<string, unknown>).to).toEqual(['as:Public']);
			const resLocal = res.locals.apex as Record<string, unknown>;
			const obj = resLocal.object as Record<string, unknown>;
			expect(obj.to).toEqual(['as:Public']);
		});

		test('handles missing body or locals safely', async () => {
			const req = makeReq(undefined);
			const res = makeRes({});

			await runMiddleware(normalizeInboxPublic, req, res);
			expect(req.body).toBeUndefined();
		});
	});
});
