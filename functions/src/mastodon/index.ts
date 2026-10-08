import cors from 'cors';
import express from 'express';
import { https, logger } from 'firebase-functions/v2';
import { beforeUserCreated, HttpsError } from 'firebase-functions/v2/identity';
import { apex } from '../apex.js';
import { db, escapeFirestoreKey } from '../firebase.js';
import { LOCAL_ADMIN_EMAIL, LOCAL_USERNAME, localActorId } from '../localActor.js';
import { UserInfos } from '../schema.js';
import { pickSafeHeaders, redactSensitiveBody } from '../utils.js';
import apiRouter from './api.js';
import oauthRouter from './oauth.js';

const app = express();
// Express 5 の既定 (simple) では `id[]=1&id[]=2` 形式の配列クエリを解釈できない (→ ADR-0087)。
app.set('query parser', 'extended');

const nodeinfoCors = cors({
	origin: true,
	methods: ['GET'],
	allowedHeaders: ['Content-Type'],
});

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

app.use('/api', apiRouter);
app.use('/oauth', oauthRouter);
app.get('/.well-known/nodeinfo', nodeinfoCors, apex, apex.net.nodeInfoLocation.get);
app.get('/nodeinfo/:version', nodeinfoCors, apex, apex.net.nodeInfo.get);

// メディアアップロード処理は mediaUploadApi (2GiB) に分離したため、mastodonApi は 256MiB で軽量稼働する (→ ADR-0093)。
export const mastodonApi = https.onRequest({ memory: '256MiB' }, app);

export { mediaUploadApi } from './mediaUploadApi.js';

export const beforeUserCreate = beforeUserCreated(async (user) => {
	if (
		!user.data ||
		user.additionalUserInfo?.providerId !== 'google.com' ||
		user.data.email !== LOCAL_ADMIN_EMAIL
	) {
		throw new HttpsError('permission-denied', `Only ${LOCAL_USERNAME} can create new account`);
	}

	const { uid } = user.data;

	await db.runTransaction(async (transaction) => {
		const nextUserId = (await transaction.get(UserInfos.count())).data().count + 1;

		transaction.set(UserInfos.doc(escapeFirestoreKey(localActorId)), {
			id: nextUserId.toString(),
			uid,
			locked: false,
			bot: false,
			created_at: new Date().toISOString(),
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: '',
			emojis: [],
			fields: [],
			roles: [],
		});
	});
});
