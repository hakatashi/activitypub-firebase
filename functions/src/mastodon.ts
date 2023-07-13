import express from 'express';
import {https, logger} from 'firebase-functions/v2';
import instance from './instanceInformation';

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

app.get('/api/v1/instance', (req, res) => {
	res.json(instance);
});

// fallback all /api routes to 501
app.use('/api', (req, res) => {
	res.status(501).send('Not implemented');
});

export const mastodonApi = https.onRequest(app);
