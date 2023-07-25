import cors from 'cors';
import express from 'express';
import {https, logger} from 'firebase-functions/v2';
import {beforeUserCreated, HttpsError} from 'firebase-functions/v2/identity';
import {apex} from '../activitypub.js';
import {db, domain} from '../firebase.js';
import {UserInfos} from '../schema.js';
import apiRouter from './api.js';
import oauthRouter from './oauth.js';

const app = express();

const nodeinfoCors = cors({
	origin: true,
	methods: ['GET'],
	allowedHeaders: ['Content-Type'],
});

app.use((req, res, next) => {
	logger.info({
		type: 'request',
		method: req.method,
		path: req.path,
		headers: req.headers,
		body: req.body,
	});
	next();
});

app.use('/api', apiRouter);
app.use('/oauth', oauthRouter);
app.get('/.well-known/nodeinfo', nodeinfoCors, apex, apex.net.nodeInfoLocation.get);
app.get('/nodeinfo/:version', nodeinfoCors, apex, apex.net.nodeInfo.get);

export const mastodonApi = https.onRequest(app);

export const beforeUserCreate = beforeUserCreated(async (user) => {
	if (user.additionalUserInfo?.providerId !== 'google.com' || user.data.email !== 'hakatasiloving@gmail.com') {
		throw new HttpsError('permission-denied', 'Only hakatashi can create new account');
	}

	const actorId = `https://${domain}/activitypub/u/hakatashi`;

	await db.runTransaction(async (transaction) => {
		const nextUserId = (await transaction.get(UserInfos.count())).data().count + 1;

		transaction.set(UserInfos.doc(actorId), {
			id: nextUserId.toString(),
			uid: user.data.uid,
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
