import cors from 'cors';
import type express from 'express';
import { logger } from 'firebase-functions/v2';
import { toError } from '../../utils.js';

export const mastodonCors = cors({
	origin: true,
	methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
	allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
	// これがないとブラウザ上のクライアントが Link ヘッダを読めずページネーションできない。
	exposedHeaders: ['Link'],
});

// Mastodon API error handling middleware (→ ADR-0074)
// oxlint-disable-next-line max-params -- Express のエラーハンドリングミドルウェアは4引数が必須
export const mastodonErrorHandler: express.ErrorRequestHandler = (
	err: unknown,
	req: express.Request,
	res: express.Response,
	_next: express.NextFunction,
) => {
	logger.error({
		type: 'mastodonApiError',
		method: req.method,
		path: req.path,
		error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
	});
	if (res.headersSent) {
		return;
	}
	const status =
		typeof (err as { statusCode?: number }).statusCode === 'number'
			? (err as { statusCode: number }).statusCode
			: 500;
	res.status(status).json({
		error: status === 500 ? 'Internal server error' : toError(err).message,
	});
};
