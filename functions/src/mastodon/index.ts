import express from 'express';
import {https, logger} from 'firebase-functions/v2';
import {apex} from '../activitypub.js';
import apiRouter from './api.js';
import oauthRouter from './oauth.js';

const app = express();

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
app.get('/.well-known/nodeinfo', apex, apex.net.nodeInfoLocation.get);
app.get('/nodeinfo/:version', apex, apex.net.nodeInfo.get);

export const mastodonApi = https.onRequest(app);
