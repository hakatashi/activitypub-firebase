import type express from 'express';
import type { APActor } from 'activitypub-types';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apex } from '../../src/apex.js';
import type { APObject as ApexObject } from '../../src/apex/index.js';
import * as mastodonId from '../../src/mastodonId.js';
import * as follows from '../../src/social/follows.js';
import * as account from '../../src/mastodon/presenters/account.js';
import * as statusAttributes from '../../src/mastodon/statusAttributes.js';
import {
	BadRequestError,
	ForbiddenError,
	HttpError,
	NotFoundError,
	UnprocessableError,
} from '../../src/mastodon/http/errors.js';
import { AuthenticationError } from '../../src/mastodon/http/auth.js';
import {
	getValidBody,
	getValidParams,
	getValidQuery,
	validate,
} from '../../src/mastodon/http/validation.js';
import {
	loadAccount,
	loadStatus,
	loadViewer,
	loadVisibleStatus,
} from '../../src/mastodon/http/loaders.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';

describe('Mastodon HTTP Errors', () => {
	it('creates HttpError with given status code and message', () => {
		const err = new HttpError(418, "I'm a teapot");
		expect(err.statusCode).toBe(418);
		expect(err.message).toBe("I'm a teapot");
		expect(err.name).toBe('HttpError');
		expect(err).toBeInstanceOf(Error);
	});

	it('creates BadRequestError with status code 400', () => {
		const err = new BadRequestError('Invalid input');
		expect(err.statusCode).toBe(400);
		expect(err.message).toBe('Invalid input');
		expect(err.name).toBe('BadRequestError');
		expect(err).toBeInstanceOf(HttpError);
	});

	it('creates NotFoundError with status code 404', () => {
		const err = new NotFoundError();
		expect(err.statusCode).toBe(404);
		expect(err.message).toBe('Record not found');
		expect(err.name).toBe('NotFoundError');
		expect(err).toBeInstanceOf(HttpError);
	});

	it('creates UnprocessableError with status code 422', () => {
		const err = new UnprocessableError('Validation failed');
		expect(err.statusCode).toBe(422);
		expect(err.message).toBe('Validation failed');
		expect(err.name).toBe('UnprocessableError');
		expect(err).toBeInstanceOf(HttpError);
	});

	it('creates ForbiddenError with status code 403', () => {
		const err = new ForbiddenError('Denied');
		expect(err.statusCode).toBe(403);
		expect(err.message).toBe('Denied');
		expect(err.name).toBe('ForbiddenError');
		expect(err).toBeInstanceOf(HttpError);
	});

	it('creates AuthenticationError with status code 401', () => {
		const err = new AuthenticationError();
		expect(err.statusCode).toBe(401);
		expect(err.message).toBe('This method requires an authenticated user');
		expect(err.name).toBe('AuthenticationError');
		expect(err).toBeInstanceOf(HttpError);
	});
});

describe('Mastodon Validation Middleware', () => {
	const createMockReqRes = (reqData: Partial<express.Request> = {}) => {
		const req = {
			params: {},
			query: {},
			body: {},
			...reqData,
		} as express.Request;
		const res = {
			locals: {},
		} as express.Response;
		const next = vi.fn();
		return { req, res, next };
	};

	it('validates params and populates res.locals.valid.params', () => {
		const schema = z.object({ id: z.string().min(1) });
		const middleware = validate({ params: schema });
		const { req, res, next } = createMockReqRes({ params: { id: '123' } });

		middleware(req, res, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(getValidParams(res, schema)).toEqual({ id: '123' });
	});

	it('throws NotFoundError when params validation fails by default', () => {
		const schema = z.object({ id: z.string().min(1) });
		const middleware = validate({ params: schema });
		const { req, res, next } = createMockReqRes({ params: { id: '' } });

		expect(() => middleware(req, res, next)).toThrow(NotFoundError);
		expect(next).not.toHaveBeenCalled();
	});

	it('validates query and populates res.locals.valid.query', () => {
		const schema = z.object({ acct: z.string().min(1) });
		const middleware = validate({ query: schema });
		const { req, res, next } = createMockReqRes({ query: { acct: 'alice' } });

		middleware(req, res, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(getValidQuery(res, schema)).toEqual({ acct: 'alice' });
	});

	it('throws BadRequestError when query validation fails by default', () => {
		const schema = z.object({ limit: z.coerce.number().int().positive() });
		const middleware = validate({ query: schema });
		const { req, res, next } = createMockReqRes({ query: { limit: 'abc' } });

		expect(() => middleware(req, res, next)).toThrow(BadRequestError);
		expect(next).not.toHaveBeenCalled();
	});

	it('throws NotFoundError when query validation fails with statusCodes.query = 404', () => {
		const schema = z.object({ acct: z.string().min(1) });
		const middleware = validate({ query: schema, statusCodes: { query: 404 } });
		const { req, res, next } = createMockReqRes({ query: { acct: '' } });

		expect(() => middleware(req, res, next)).toThrow(NotFoundError);
		expect(next).not.toHaveBeenCalled();
	});

	it('validates body and populates res.locals.valid.body', () => {
		const schema = z.object({ status: z.string() });
		const middleware = validate({ body: schema });
		const { req, res, next } = createMockReqRes({ body: { status: 'hello' } });

		middleware(req, res, next);

		expect(next).toHaveBeenCalledTimes(1);
		expect(getValidBody(res, schema)).toEqual({ status: 'hello' });
	});

	it('throws UnprocessableError with issues message when body validation fails by default', () => {
		const schema = z.object({ status: z.string().min(1, 'Text required') });
		const middleware = validate({ body: schema });
		const { req, res, next } = createMockReqRes({ body: { status: '' } });

		expect(() => middleware(req, res, next)).toThrow(UnprocessableError);
		expect(() => middleware(req, res, next)).toThrow('Validation failed: Text required');
		expect(next).not.toHaveBeenCalled();
	});

	it('throws BadRequestError when body validation fails with statusCodes.body = 400', () => {
		const schema = z.object({ name: z.string().min(1) });
		const middleware = validate({ body: schema, statusCodes: { body: 400 } });
		const { req, res, next } = createMockReqRes({ body: { name: '' } });

		expect(() => middleware(req, res, next)).toThrow(BadRequestError);
		expect(next).not.toHaveBeenCalled();
	});
});

describe('Mastodon Resource Loaders', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('loadStatus', () => {
		it('throws NotFoundError when id is invalid', async () => {
			await expect(loadStatus('')).rejects.toThrow(NotFoundError);
		});

		it('throws NotFoundError when IRI is not found for Mastodon ID', async () => {
			vi.spyOn(mastodonId, 'getIriByMastodonId').mockResolvedValueOnce(undefined);
			await expect(loadStatus('12345')).rejects.toThrow(NotFoundError);
		});

		it('throws NotFoundError when object is not a Note', async () => {
			vi.spyOn(mastodonId, 'getIriByMastodonId').mockResolvedValueOnce(
				'https://example.com/note/1',
			);
			vi.spyOn(apex.store, 'getObject').mockResolvedValueOnce({
				type: 'Tombstone',
				id: 'https://example.com/note/1',
			});
			await expect(loadStatus('12345')).rejects.toThrow(NotFoundError);
		});

		it('returns NoteObject when found and valid', async () => {
			const note = {
				type: 'Note',
				id: 'https://example.com/note/1',
				content: 'test',
			};
			vi.spyOn(mastodonId, 'getIriByMastodonId').mockResolvedValueOnce(
				'https://example.com/note/1',
			);
			vi.spyOn(apex.store, 'getObject').mockResolvedValueOnce(note);

			const result = await loadStatus('12345');
			expect(result).toEqual(note);
		});
	});

	describe('loadVisibleStatus', () => {
		it('throws NotFoundError when note is not visible to viewer', async () => {
			const note = {
				type: 'Note',
				id: 'https://example.com/note/1',
				content: 'test',
			};
			vi.spyOn(mastodonId, 'getIriByMastodonId').mockResolvedValueOnce(
				'https://example.com/note/1',
			);
			vi.spyOn(apex.store, 'getObject').mockResolvedValueOnce(note);
			vi.spyOn(statusAttributes, 'isNoteVisibleTo').mockReturnValueOnce(false);

			await expect(loadVisibleStatus('12345')).rejects.toThrow(NotFoundError);
		});

		it('does not fetch following for public notes by default', async () => {
			const note = {
				type: 'Note',
				id: 'https://example.com/note/1',
				content: 'test',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
			};
			const viewer = {
				type: 'Person',
				id: 'https://example.com/users/alice',
			} as const;
			vi.spyOn(mastodonId, 'getIriByMastodonId').mockResolvedValueOnce(
				'https://example.com/note/1',
			);
			vi.spyOn(apex.store, 'getObject').mockResolvedValueOnce(note);
			const getFollowingSpy = vi.spyOn(follows, 'getFollowing');
			vi.spyOn(statusAttributes, 'isNoteVisibleTo').mockReturnValueOnce(true);

			const result = await loadVisibleStatus('12345', viewer as unknown as APActor);
			expect(result.note).toEqual(note);
			expect(getFollowingSpy).not.toHaveBeenCalled();
			expect(result.viewerFollowing.size).toBe(0);
		});

		it('fetches following when loadFollowing is true', async () => {
			const note = {
				type: 'Note',
				id: 'https://example.com/note/1',
				content: 'test',
				to: ['https://www.w3.org/ns/activitystreams#Public'],
			};
			const viewer = {
				type: 'Person',
				id: 'https://example.com/users/alice',
			} as const;
			vi.spyOn(mastodonId, 'getIriByMastodonId').mockResolvedValueOnce(
				'https://example.com/note/1',
			);
			vi.spyOn(apex.store, 'getObject').mockResolvedValueOnce(note);
			vi.spyOn(follows, 'getFollowing').mockResolvedValueOnce(['https://example.com/users/bob']);
			vi.spyOn(statusAttributes, 'isNoteVisibleTo').mockReturnValueOnce(true);

			const result = await loadVisibleStatus('12345', viewer as unknown as APActor, {
				loadFollowing: true,
			});
			expect(result.note).toEqual(note);
			expect(result.viewerFollowing.has('https://example.com/users/bob')).toBe(true);
		});

		it('fetches following for private notes from other authors', async () => {
			const note = {
				type: 'Note',
				id: 'https://example.com/note/1',
				content: 'test',
				attributedTo: 'https://example.com/users/bob',
				to: ['https://example.com/users/bob/followers'],
			};
			const viewer = {
				type: 'Person',
				id: 'https://example.com/users/alice',
			} as const;
			vi.spyOn(mastodonId, 'getIriByMastodonId').mockResolvedValueOnce(
				'https://example.com/note/1',
			);
			vi.spyOn(apex.store, 'getObject').mockResolvedValueOnce(note);
			vi.spyOn(follows, 'getFollowing').mockResolvedValueOnce(['https://example.com/users/bob']);
			vi.spyOn(statusAttributes, 'isNoteVisibleTo').mockReturnValueOnce(true);

			const result = await loadVisibleStatus('12345', viewer as unknown as APActor);
			expect(result.note).toEqual(note);
			expect(result.viewerFollowing.has('https://example.com/users/bob')).toBe(true);
		});
	});

	describe('loadAccount', () => {
		it('throws NotFoundError when id is empty', async () => {
			await expect(loadAccount('')).rejects.toThrow(NotFoundError);
		});

		it('throws NotFoundError when resolveAccountActor returns undefined', async () => {
			vi.spyOn(account, 'resolveAccountActor').mockResolvedValueOnce(undefined);
			await expect(loadAccount('12345')).rejects.toThrow(NotFoundError);
		});

		it('returns resolved account when found', async () => {
			const resolved: account.ResolvedAccountActor = {
				actor: {
					id: 'https://example.com/u/1',
					type: 'Person',
				} as unknown as account.ResolvedAccountActor['actor'],
			};
			vi.spyOn(account, 'resolveAccountActor').mockResolvedValueOnce(resolved);

			const result = await loadAccount('12345');
			expect(result).toBe(resolved);
		});
	});

	describe('loadViewer', () => {
		it('throws AssertionError when res.locals.actorId is missing', async () => {
			const res = { locals: {} } as express.Response;
			await expect(loadViewer(res)).rejects.toThrow();
		});

		it('returns actor with meta when present', async () => {
			const actorObj = {
				id: 'https://example.com/u/alice',
				type: 'Person',
				inbox: 'https://example.com/u/alice/inbox',
				outbox: 'https://example.com/u/alice/outbox',
			} as unknown as ApexObject & APActor;
			const res = {
				locals: { actorId: 'https://example.com/u/alice' },
			} as unknown as express.Response;
			vi.spyOn(apex.store, 'getObject').mockResolvedValueOnce(actorObj);

			const result = await loadViewer(res);
			expect(result).toBe(actorObj);
		});
	});
});

// Express 5 では async ハンドラの reject がエラーハンドラへ渡る (→ ADR-0087)
describe('Mastodon API router on Express 5', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	it('responds with the HttpError status when an async handler rejects with it', async () => {
		vi.spyOn(account, 'resolveAccountActor').mockResolvedValueOnce(undefined);

		const response = await request(mastodon).get('/api/v1/accounts/12345');
		expect(response.status).toBe(404);
		expect(response.body).toEqual({ error: 'Record not found' });
	});

	it('responds with 500 when an async handler rejects with an unexpected error', async () => {
		vi.spyOn(account, 'resolveAccountActor').mockRejectedValueOnce(new Error('boom'));

		const response = await request(mastodon).get('/api/v1/accounts/12345');
		expect(response.status).toBe(500);
		expect(response.body).toEqual({ error: 'Internal server error' });
	});

	it('parses `id[]` array queries with the extended query parser', async () => {
		await createLocalActor('hakatashi', { uid: 'uid-hakatashi' });
		await addAccessToken('relationships-token', 'read');
		const getRelationships = vi.spyOn(account, 'getRelationships').mockResolvedValueOnce([]);

		const response = await request(mastodon)
			.get('/api/v1/accounts/relationships?id[]=1&id[]=2')
			.set('Authorization', 'Bearer relationships-token');
		expect(response.status).toBe(200);
		expect(getRelationships).toHaveBeenCalledWith(expect.anything(), ['1', '2']);
	});
});
