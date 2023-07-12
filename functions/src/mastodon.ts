import {https, logger} from 'firebase-functions/v2';

export const mastodonApi = https.onRequest((req, res) => {
	logger.info({
		type: 'request',
		method: req.method,
		path: req.path,
		headers: req.headers,
		body: req.body,
	});
	res.status(501).send('Not implemented');
});
