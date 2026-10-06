import express from 'express';

const wrapAsyncHandler = (h: unknown): unknown => {
	if (Array.isArray(h)) {
		return h.map(wrapAsyncHandler);
	}
	if (typeof h === 'function') {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return (req: any, res: any, next: any) => {
			try {
				const ret = h(req, res, next);
				if (ret && typeof ret.catch === 'function') {
					ret.catch(next);
				}
			} catch (error) {
				next(error);
			}
		};
	}
	return h;
};

export const createAsyncRouter = (): express.Router => {
	const router = express.Router();
	const methods = ['get', 'post', 'put', 'delete', 'patch'] as const;
	for (const method of methods) {
		const original = router[method].bind(router) as (...args: unknown[]) => express.IRouter;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		router[method] = ((path: any, ...handlers: any[]) => {
			const wrapped = handlers.map(wrapAsyncHandler);
			return original(path, ...wrapped);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any;
	}
	return router;
};
