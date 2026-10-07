import cors from 'cors';
import express from 'express';
import { logger } from 'firebase-functions/v2';
import { toError } from '../utils.js';
import accountsRouter from './routes/accounts.js';
import appsRouter from './routes/apps.js';
import instanceRouter from './routes/instance.js';
import markersRouter from './routes/markers.js';
import mediaRouter from './routes/media.js';
import notificationsRouter from './routes/notifications.js';
import statusActionsRouter from './routes/statusActions.js';
import statusesRouter from './routes/statuses.js';
import stubsRouter from './routes/stubs.js';
import timelinesRouter from './routes/timelines.js';

// `/api/**` のルーティング。各リソースのルートは `routes/` に、エンティティ変換は `presenters/` にある。
// 登録順に意味がある (末尾の 404 フォールバックとエラーハンドラは最後に置く)。
const router = express.Router();

router.use(
	'/',
	cors({
		origin: true,
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
		allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
		// これがないとブラウザ上のクライアントが Link ヘッダを読めずページネーションできない。
		exposedHeaders: ['Link'],
	}),
);

router.use(instanceRouter);
router.use(stubsRouter);
router.use(markersRouter);
router.use(accountsRouter);
router.use(timelinesRouter);
router.use(statusesRouter);
router.use(statusActionsRouter);
router.use(notificationsRouter);
router.use(mediaRouter);
router.use(appsRouter);

// fallback all /api routes to 404 (→ ADR-0067)
router.use('/', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

// Mastodon API error handling middleware (→ ADR-0074)
router.use(
	// oxlint-disable-next-line max-params -- Express のエラーハンドリングミドルウェアは4引数が必須
	(err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
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
	},
);

export default router;
