import crypto from 'crypto';
import OAuth2Server, {Request as OauthRequest, Response as OauthResponse} from '@node-oauth/oauth2-server';
import {htmlEscape} from 'escape-goat';
import express from 'express';
import {https, logger} from 'firebase-functions/v2';
import type {mastodon} from 'masto';
import {apex} from './activitypub.js';
import {domain, mastodonDomain} from './firebase.js';
import {instanceV1, instanceV2} from './instanceInformation.js';
import {Clients, Oauth2Model} from './oauth2Model.js';
import type {CamelToSnake} from './utils.js';

const validScopes = ['follow', 'push', 'read', 'read:accounts', 'read:blocks', 'read:blocks', 'read:bookmarks', 'read:favourites', 'read:filters', 'read:follows', 'read:follows', 'read:lists', 'read:mutes', 'read:mutes', 'read:notifications', 'read:search', 'read:statuses', 'write', 'write:accounts', 'write:blocks', 'write:blocks', 'write:bookmarks', 'write:conversations', 'write:favourites', 'write:filters', 'write:follows', 'write:follows', 'write:lists', 'write:media', 'write:mutes', 'write:mutes', 'write:notifications', 'write:reports', 'write:statuses'];

const oauth = new OAuth2Server({
	model: new Oauth2Model(),
});

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
	const object = await apex.store.getObject(actorId);
	if (object === undefined) {
		return undefined;
	}

	const actor = await apex.toJSONLD(object);

	const statuses = await apex.store.getObjects('attributedTo', actorId);

	return {
		id: '1', // FIXME: rank it
		username: actor.preferredUsername,
		acct: `${username}@${domain}`,
		display_name: actor.name,
		url: `https://elk.zone/${mastodonDomain}/@${username}@${domain}`,
		avatar: actor?.icon?.url,
		avatar_static: actor?.icon?.url,
		header: actor?.image?.url,
		header_static: actor?.image?.url,
		note: actor.summary,
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

app.get('/api/v1/accounts/:id/statuses', (req, res) => {
	res.json([exampleStatus]);
});

app.get('/api/v1/timelines/public', (req, res) => {
	res.json([exampleStatus]);
});

app.post('/api/v1/apps', async (req, res) => {
	const clientName = req.body?.client_name;
	const redirectUris = req.body?.redirect_uris;
	const scopes = req.body?.scopes ?? 'read';
	const website = req.body?.website ?? '';

	if (
		typeof clientName !== 'string' ||
		typeof redirectUris !== 'string' ||
		typeof scopes !== 'string' ||
		typeof website !== 'string'
	) {
		res.status(400).send('Bad request');
		return;
	}

	const scopeSet = new Set<string>(scopes.split(' '));
	for (const scope of scopeSet) {
		if (!validScopes.includes(scope)) {
			res.status(400).send('Bad request');
			return;
		}
	}

	const id = (await Clients.count().get()).data().count + 1;
	const clientId = crypto.randomBytes(32).toString('hex');
	const clientSecret = crypto.randomBytes(32).toString('hex');
	const vapidKey = crypto.randomBytes(32).toString('hex');

	await Clients.add({
		id: id.toString(),
		name: clientName,
		redirectUris,
		grants: ['authorization_code', 'refresh_token'],
		clientId,
		clientSecret,
		scopes: Array.from(scopeSet),
		vapidKey,
	});

	res.json({
		id: id.toString(),
		client_id: clientId,
		client_secret: clientSecret,
		redirect_uri: redirectUris,
		name: clientName,
		website,
		vapid_key: vapidKey,
	});
});

// fallback all /api routes to 501
app.use('/api', (req, res) => {
	res.status(501).send('Not implemented');
});

app.get('/oauth/authorize', (req, res) => {
	logger.info({
		type: 'oauthAuthorizeGet',
		params: req.query,
	});

	const clientId = req.query.client_id;
	const redirectUri = req.query.redirect_uri;
	const responseType = req.query.response_type;
	const scope = req.query.scope ?? 'scope';

	if (
		typeof clientId !== 'string' ||
		typeof redirectUri !== 'string' ||
		typeof responseType !== 'string' ||
		typeof scope !== 'string'
	) {
		res.status(400).send('Bad request');
		return;
	}

	res.status(200)
		.contentType('text/html')
		.send(
			htmlEscape`
				<!DOCTYPE html>
				<html lang="en">
					<head>
						<meta charset="utf-8">
						<title>Authorize</title>
					</head>
					<body>
						<pre>${JSON.stringify(req.query, null, '  ')}</pre>
						<form action="/oauth/authorize" accept-charset="UTF-8" method="post">
							<input type="hidden" name="client_id" id="client_id" value="${clientId}" autocomplete="off">
							<input type="hidden" name="redirect_uri" id="redirect_uri" value="${redirectUri}" autocomplete="off">
							<!-- <input type="hidden" name="state" id="state" autocomplete="off"> -->
							<input type="hidden" name="response_type" id="response_type" value="${responseType}" autocomplete="off">
							<input type="hidden" name="scope" id="scope" value="${scope}" autocomplete="off">
							<button name="button" type="submit">承認</button>
						</form>
					</body>
				</html>
			`,
		);
});

app.post('/oauth/authorize', async (req, res) => {
	const request = new OauthRequest(req);
	const response = new OauthResponse(res);

	try {
		const token = await oauth.authorize(request, response, {
			allowEmptyState: true,
			authenticateHandler: {
				handle() {
					// TODO: Implement session handling
					return {
						userId: '1337',
					};
				},
			},
		});

		logger.info({
			type: 'oauthAuthorizePost',
			token,
			response: response.body,
		});

		// eslint-disable-next-line require-atomic-updates
		res.locals.oauth = {token};

		res.set(response.headers);
		res.status(response.status ?? 200).send(response.body);
	} catch (error) {
		logger.error({
			type: 'oauthAuthorizePost',
			error,
		});
		res.status(400).send('Bad request');
	}
});

app.get('/oauth/token', async (req, res) => {
	const request = new OauthRequest(req);
	const response = new OauthResponse(res);

	try {
		const token = await oauth.token(request, response, {
			accessTokenLifetime: 24 * 60 * 60,
			refreshTokenLifetime: 30 * 24 * 60 * 60,
		});

		logger.info({
			type: 'oauthToken',
			token,
			response: response.body,
		});

		res.set(response.headers);
		res.status(response.status ?? 200).send(token);
	} catch (error) {
		logger.error({
			type: 'oauthTokenPost',
			error,
		});
		res.status(400).send('Bad request');
	}
});

app.get('/oauth/revoke', (req, res) => {
	res.sendStatus(501);
});

export const mastodonApi = https.onRequest(app);
