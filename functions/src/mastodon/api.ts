import express from 'express';
import { mastodonCors, mastodonErrorHandler } from './http/middlewares.js';
import accountsRouter from './routes/accounts.js';
import appsRouter from './routes/apps.js';
import instanceRouter from './routes/instance.js';
import markersRouter from './routes/markers.js';
import noteCollectionsRouter from './routes/noteCollections.js';
import notificationsRouter from './routes/notifications.js';
import profileRouter from './routes/profile.js';
import searchRouter from './routes/search.js';
import statusActionsRouter from './routes/statusActions.js';
import statusesRouter from './routes/statuses.js';
import stubsRouter from './routes/stubs.js';
import tagsRouter from './routes/tags.js';
import timelinesRouter from './routes/timelines.js';

// `/api/**` のルーティング。各リソースのルートは `routes/` に、エンティティ変換は `presenters/` にある。
// 登録順に意味がある (末尾の 404 フォールバックとエラーハンドラは最後に置く)。
// メディア系 API (/api/v1/media*, /api/v2/media*) は mediaUploadApi に分離 (→ ADR-0093)。
const router = express.Router();

router.use('/', mastodonCors);

router.use(instanceRouter);
router.use(stubsRouter);
router.use(markersRouter);
// `/v1/accounts/search` を `/v1/accounts/:id` より先に登録する。
router.use(searchRouter);
router.use(accountsRouter);
router.use(profileRouter);
router.use(timelinesRouter);
router.use(tagsRouter);
router.use(statusesRouter);
router.use(statusActionsRouter);
router.use(noteCollectionsRouter);
router.use(notificationsRouter);
router.use(appsRouter);

// fallback all /api routes to 404 (→ ADR-0067)
router.use('/', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

// Mastodon API error handling middleware (→ ADR-0074)
router.use(mastodonErrorHandler);

export default router;
