import assert from 'assert';
import crypto from 'crypto';
import {Request as OauthRequest, Response as OauthResponse} from '@node-oauth/oauth2-server';
import cors from 'cors';
import express from 'express';
import type {mastodon} from 'masto';
import {apex} from '../activitypub.js';
import {domain, escapeFirestoreKey, mastodonDomain} from '../firebase.js';
import {UserInfos} from '../schema.js';
import {instanceV1, instanceV2} from './instanceInformation.js';
import {oauth} from './oauth.js';
import {Clients} from './oauth2Model.js';
import type {CamelToSnake} from './utils.js';

const validScopes = ['follow', 'push', 'read', 'read:accounts', 'read:blocks', 'read:blocks', 'read:bookmarks', 'read:favourites', 'read:filters', 'read:follows', 'read:follows', 'read:lists', 'read:mutes', 'read:mutes', 'read:notifications', 'read:search', 'read:statuses', 'write', 'write:accounts', 'write:blocks', 'write:blocks', 'write:bookmarks', 'write:conversations', 'write:favourites', 'write:filters', 'write:follows', 'write:follows', 'write:lists', 'write:media', 'write:mutes', 'write:mutes', 'write:notifications', 'write:reports', 'write:statuses'];

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
	const [object, userInfoDoc] = await Promise.all([
		apex.store.getObject(actorId) as Promise<any>,
		UserInfos.doc(escapeFirestoreKey(actorId)).get(),
	]);
	if (object === undefined || !userInfoDoc.exists) {
		return undefined;
	}

	const userInfo = userInfoDoc.data()!;

	const actor = await apex.toJSONLD(object);

	return {
		...userInfo,
		username: actor.preferredUsername,
		acct: `${username}@${domain}`,
		display_name: actor.name,
		url: `https://elk.zone/${mastodonDomain}/@${username}@${domain}`,
		avatar: actor?.icon?.url,
		avatar_static: actor?.icon?.url,
		header: actor?.image?.url,
		header_static: actor?.image?.url,
		note: actor.summary,
		discoverable: actor.discoverable,
	};
};

const authRequired = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
	const request = new OauthRequest(req);
	const response = new OauthResponse(res);
	const token = await oauth.authenticate(request, response);

	const uid = token.user?.userId;
	assert(typeof uid === 'string');

	const userInfoDocs = await UserInfos.where('uid', '==', uid).get();
	assert(!userInfoDocs.empty);
	assert(userInfoDocs.size === 1);

	const userInfoDoc = userInfoDocs.docs[0];

	// eslint-disable-next-line require-atomic-updates
	res.locals.auth = userInfoDoc.data();

	next();
};

const router = express.Router();

router.use('/', cors({
	origin: true,
	methods: ['GET', 'POST'],
	allowedHeaders: ['Authorization', 'Content-Type'],
}));

router.get('/v1/instance', (req, res) => {
	res.json(instanceV1);
});

router.get('/v2/instance', (req, res) => {
	res.json(instanceV2);
});

router.get('/v1/accounts/lookup', async (req, res) => {
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

router.get('/v1/accounts/:id/statuses', (req, res) => {
	res.json([exampleStatus]);
});

router.get('/v1/accounts/verify_credentials', authRequired, (req, res) => {
	res.json(res.locals.auth);
});

router.get('/v1/timelines/public', (req, res) => {
	res.json([exampleStatus]);
});

router.post('/v1/apps', async (req, res) => {
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
router.use('/', (req, res) => {
	res.status(501).send('Not implemented');
});

export default router;
