import express from 'express';
import { https, logger } from 'firebase-functions/v2';
import { pickSafeHeaders, redactSensitiveBody } from '../utils.js';
import { mastodonCors, mastodonErrorHandler } from './http/middlewares.js';
import mediaRouter from './routes/media.js';

// メディアのアップロード・取得・編集専用の Express アプリケーション (→ ADR-0093)。
// Firebase Hosting により `/api/v1/media*` および `/api/v2/media*` がここにリライトされる。
const app = express();
app.set('query parser', 'extended');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
	logger.info({
		type: 'request',
		method: req.method,
		path: req.path,
		headers: pickSafeHeaders(req.headers),
		body: redactSensitiveBody(req.body),
	});
	next();
});

app.use('/api', mastodonCors);
app.use('/api', mediaRouter);

// fallback to 404
app.use('/api', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

// Mastodon API error handling middleware (→ ADR-0074)
app.use(mastodonErrorHandler);

// 画像処理 (sharp) のメモリ消費に対応するため 2GiB (1.0 vCPU) を割り当て、
// モバイル環境等からの大容量ファイルアップロードを考慮してタイムアウトを 120 秒に設定する (→ ADR-0093)。
export const mediaUploadApi = https.onRequest(
	{
		memory: '2GiB',
		timeoutSeconds: 120,
	},
	app,
);
