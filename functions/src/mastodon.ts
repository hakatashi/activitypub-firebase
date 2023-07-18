import express from 'express';
import {https, logger} from 'firebase-functions/v2';
import type {mastodon} from 'masto';
import {apex} from './activitypub';
import {domain} from './firebase';
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
	uri: `https://${domain}/@hakatashi/1`,
	url: `https://${domain}/@hakatashi/1`,
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
		website: `https://${domain}`,
	},
	account: {
		id: '1',
		username: 'hakatashi',
		acct: `hakatashi@${domain}`,
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

const actorUsernameToAccount = async (username: string): Promise<CamelToSnake<mastodon.v1.Account> | undefined> => {
	const actorId = `https://${domain}/activitypub/u/${username}`;
	const actor = await apex.store.getObject(actorId);
	if (actor === undefined) {
		return undefined;
	}

	const statuses = await apex.store.getObjects('attributedTo', actorId);

	return {
		id: '1', // FIXME: rank it
		username: actor.preferredUsername[0],
		acct: username,
		display_name: actor.name[0],
		url: `https://elk.zone/mastodon.hakatashi.com/@${username}`,
		avatar: actor.icon[0].url[0],
		avatar_static: actor.icon[0].url[0],
		header: '',
		header_static: '',
		note: actor.summary[0],
		locked: false,
		emojis: [],
		fields: [],
		discoverable: true,
		created_at: new Date(2020, 1, 1).toISOString(),
		statuses_count: statuses.length,
		followers_count: 0,
		following_count: 0,
		last_status_at: statuses.length === 0 ? null : statuses[0].published,
		roles: [],
	};
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

app.get('/api/v1/accounts/lookup', async (req, res) => {
	const acct = req.query.acct;
	if (typeof acct !== 'string') {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const [username, lookupDomain = domain] = acct.split('@');

	if (lookupDomain !== domain) {
		res.status(501).send('Not implemented');
		return;
	}

	const account = await actorUsernameToAccount(username);

	if (account === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
	}

	res.json(account);
});

app.get('/api/v1/timelines/public', (req, res) => {
	res.json([exampleStatus]);
});

// fallback all /api routes to 501
app.use('/api', (req, res) => {
	res.status(501).send('Not implemented');
});

export const mastodonApi = https.onRequest(app);
