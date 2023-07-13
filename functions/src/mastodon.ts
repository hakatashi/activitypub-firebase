import express from 'express';
import {https, logger} from 'firebase-functions/v2';
import type {mastodon} from 'masto';
import {instanceV1, instanceV2} from './instanceInformation';
import type {CamelToSnake} from './utils';

const exampleStatus: CamelToSnake<mastodon.v1.Status> = {
	id: '1',
	created_at: '2021-08-01T00:00:00.000Z',
	edited_at: null,
	in_reply_to_id: null,
	in_reply_to_account_id: null,
	sensitive: false,
	spoiler_text: '',
	visibility: 'public',
	language: 'ja',
	uri: 'https://hakatashi.com/@hakatashi/1',
	url: 'https://hakatashi.com/@hakatashi/1',
	replies_count: 0,
	reblogs_count: 0,
	favourites_count: 0,
	reblogged: false,
	favourited: false,
	muted: false,
	bookmarked: false,
	pinned: false,
	content: 'Hello, world!',
	reblog: null,
	application: {
		name: 'HakataFediverse',
		website: 'https://hakatashi.com',
	},
	account: {
		id: '1',
		username: 'hakatashi',
		acct: 'hakatashi@hakatashi.com',
		display_name: 'hakatashi',
		locked: false,
		bot: false,
		discoverable: true,
		created_at: '2016-03-16T00:00:00.000Z',
		note: '博多市です。',
		url: 'https://mastodon.social/@Gargron',
		avatar: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
		avatar_static: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
		header: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
		header_static: 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png',
		followers_count: 1,
		following_count: 1,
		statuses_count: 0,
		last_status_at: '2022-08-24',
		emojis: [],
		fields: [],
		roles: [],
	},
	media_attachments: [],
	mentions: [],
	tags: [],
	emojis: [],
	card: null,
	poll: null,
};


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
	res.json(instanceV1);
});

app.get('/api/v2/instance', (req, res) => {
	res.json(instanceV2);
});

app.get('/api/v1/timelines/public', (req, res) => {
	res.json([exampleStatus]);
});

// fallback all /api routes to 501
app.use('/api', (req, res) => {
	res.status(501).send('Not implemented');
});

export const mastodonApi = https.onRequest(app);
