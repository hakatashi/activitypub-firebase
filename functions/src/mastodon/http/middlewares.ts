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

// 4xx / 5xx 応答を CDN やブラウザにキャッシュさせない (→ ADR-0129)。
// Hosting は Cache-Control のない応答に `max-age=600` を付けるため、`search` で解決する前の `lookup` の
// 404 が残ってしまう。ハンドラが明示した Cache-Control は尊重する。
export const noStoreErrors: express.RequestHandler = (_req, res, next) => {
	const originalWriteHead = res.writeHead.bind(res) as (...args: unknown[]) => express.Response;
	res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
		if (statusCode >= 400 && !res.hasHeader('Cache-Control')) {
			res.setHeader('Cache-Control', 'no-store');
		}
		return originalWriteHead(statusCode, ...rest);
	}) as typeof res.writeHead;
	next();
};

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
