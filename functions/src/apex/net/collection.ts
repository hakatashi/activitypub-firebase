import type { NextFunction, Request, Response } from 'express';
import type { CollectionPage } from '../pub/collection.js';
import type { Apex, APObject } from '../types.js';
import { getApex, getLocals } from './locals.js';

type CollectionGetter = (
	apex: Apex,
	target: APObject,
	page: CollectionPage,
	authorized: boolean | undefined,
	req: Request,
) => Promise<APObject> | undefined;

const collectionMiddleware =
	(getCollection: CollectionGetter) =>
	(req: Request, res: Response, next: NextFunction): void => {
		const apex = getApex(req);
		const locals = getLocals(res);
		const page = typeof req.query.page === 'string' ? req.query.page : undefined;
		const collection =
			locals.target && getCollection(apex, locals.target, page, locals.authorized, req);
		if (!collection) {
			next();
			return;
		}
		collection
			.then((col) => {
				locals.result = col;
				next();
			})
			.catch((err: unknown) => {
				if (err instanceof Error && err.message === 'ApexStore: invalid page value') {
					locals.status = 400;
					locals.statusMessage = 'invalid page value';
					apex.logger.info('Invalid collection page request: ', req.originalUrl);
					next();
				} else {
					next(err);
				}
			});
	};

export const blocked = collectionMiddleware((apex, target, page, authorized) =>
	apex.getBlocked(target, page, authorized),
);

export const inbox = collectionMiddleware((apex, target, page, authorized) =>
	apex.getInbox(target, page, authorized),
);

export const outbox = collectionMiddleware((apex, target, page, authorized) =>
	apex.getOutbox(target, page, authorized),
);

export const followers = collectionMiddleware((apex, target, page, authorized) =>
	apex.getFollowers(target, page, authorized),
);

export const following = collectionMiddleware((apex, target, page, authorized) =>
	apex.getFollowing(target, page, authorized),
);

export const liked = collectionMiddleware((apex, target, page, authorized) =>
	apex.getLiked(target, page, authorized),
);

export const shares = collectionMiddleware((apex, target, page, authorized) =>
	apex.getShares(target, page, authorized),
);

export const likes = collectionMiddleware((apex, target, page, authorized) =>
	apex.getLikes(target, page, authorized),
);

export const added = collectionMiddleware((apex, target, page, authorized, req) => {
	const colId = req.params[apex.collectionParam];
	return colId ? apex.getAdded(target, colId, page, authorized) : undefined;
});

export const rejected = collectionMiddleware((apex, target, page, authorized) =>
	apex.getRejected(target, page, authorized),
);

export const rejections = collectionMiddleware((apex, target, page, authorized) =>
	apex.getRejections(target, page, authorized),
);
