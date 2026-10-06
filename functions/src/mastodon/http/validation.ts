import assert from 'node:assert';
import type express from 'express';
import type { z } from 'zod';
import { BadRequestError, HttpError, NotFoundError, UnprocessableError } from './errors.js';
import './locals.js';

export interface ValidateOptions<
	TParams extends z.ZodTypeAny = z.ZodTypeAny,
	TQuery extends z.ZodTypeAny = z.ZodTypeAny,
	TBody extends z.ZodTypeAny = z.ZodTypeAny,
> {
	params?: TParams;
	query?: TQuery;
	body?: TBody;
	statusCodes?: {
		params?: number;
		query?: number;
		body?: number;
	};
}

export const validate =
	<
		TParams extends z.ZodTypeAny = z.ZodTypeAny,
		TQuery extends z.ZodTypeAny = z.ZodTypeAny,
		TBody extends z.ZodTypeAny = z.ZodTypeAny,
	>(
		options: ValidateOptions<TParams, TQuery, TBody>,
	): express.RequestHandler =>
	(req, res, next) => {
		res.locals.valid ??= {};

		if (options.params !== undefined) {
			const parsed = options.params.safeParse(req.params);
			if (!parsed.success) {
				const status = options.statusCodes?.params ?? 404;
				if (status === 404) {
					throw new NotFoundError();
				}
				throw new HttpError(status, parsed.error.issues[0]?.message ?? 'Invalid params');
			}
			res.locals.valid.params = parsed.data;
		}

		if (options.query !== undefined) {
			const parsed = options.query.safeParse(req.query);
			if (!parsed.success) {
				const status = options.statusCodes?.query ?? 400;
				if (status === 404) {
					throw new NotFoundError();
				}
				if (status === 422) {
					throw new UnprocessableError(
						`Validation failed: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
					);
				}
				throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Bad request');
			}
			res.locals.valid.query = parsed.data;
		}

		if (options.body !== undefined) {
			const parsed = options.body.safeParse(req.body ?? {});
			if (!parsed.success) {
				const status = options.statusCodes?.body ?? 422;
				if (status === 400) {
					throw new BadRequestError('Bad request');
				}
				if (status === 422) {
					throw new UnprocessableError(
						`Validation failed: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
					);
				}
				throw new HttpError(status, parsed.error.issues[0]?.message ?? 'Invalid body');
			}
			res.locals.valid.body = parsed.data;
		}

		next();
	};

export const getValidParams = <T extends z.ZodTypeAny>(
	res: express.Response,
	_schema: T,
): z.infer<T> => {
	assert(res.locals.valid?.params !== undefined, 'Validated params not found in res.locals');
	return res.locals.valid.params as z.infer<T>;
};

export const getValidQuery = <T extends z.ZodTypeAny>(
	res: express.Response,
	_schema: T,
): z.infer<T> => {
	assert(res.locals.valid?.query !== undefined, 'Validated query not found in res.locals');
	return res.locals.valid.query as z.infer<T>;
};

export const getValidBody = <T extends z.ZodTypeAny>(
	res: express.Response,
	_schema: T,
): z.infer<T> => {
	assert(res.locals.valid?.body !== undefined, 'Validated body not found in res.locals');
	return res.locals.valid.body as z.infer<T>;
};
