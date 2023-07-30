import assert from 'assert';
import crypto from 'crypto';
import {Request as OauthRequest, Response as OauthResponse} from '@node-oauth/oauth2-server';
import type {APNote, APActor, APObject} from 'activitypub-types';
import cors from 'cors';
import express from 'express';
import firebase from 'firebase-admin';
import {last, zip} from 'lodash-es';
import type {mastodon} from 'masto';
import {apex} from '../activitypub.js';
import {db, domain, escapeFirestoreKey, mastodonDomain, unescapeFirestoreKey} from '../firebase.js';
import {UserInfo, UserInfos} from '../schema.js';
import type {CamelToSnake} from '../utils.js';
import {Counter} from '../utils.js';
import {instanceV1, instanceV2} from './instanceInformation.js';
import {oauth} from './oauth.js';
import {Clients} from './oauth2Model.js';

const validScopes = ['follow', 'push', 'read', 'read:accounts', 'read:blocks', 'read:blocks', 'read:bookmarks', 'read:favourites', 'read:filters', 'read:follows', 'read:follows', 'read:lists', 'read:mutes', 'read:mutes', 'read:notifications', 'read:search', 'read:statuses', 'write', 'write:accounts', 'write:blocks', 'write:blocks', 'write:bookmarks', 'write:conversations', 'write:favourites', 'write:filters', 'write:follows', 'write:follows', 'write:lists', 'write:media', 'write:mutes', 'write:mutes', 'write:notifications', 'write:reports', 'write:statuses'];

const externalUserInfo: UserInfo = {
	bot: false,
	created_at: '2021-01-01T00:00:00.000Z',
	emojis: [],
	fields: [],
	followers_count: 0,
	following_count: 0,
	id: '1',
	last_status_at: '',
	locked: false,
	roles: [],
	statuses_count: 0,
	uid: null,
};

const actorObjectToAccount = async (actorObject: APActor, userInfo: UserInfo = externalUserInfo): Promise<CamelToSnake<mastodon.v1.Account>> => {
	const actor = await apex.toJSONLD(actorObject);
	const username = actor?.preferredUsername ?? last(actor?.id?.split('/'));
	const actorDomain = new URL(actor.id).host;

	return {
		...userInfo,
		username: actor.preferredUsername,
		acct: `${username}@${actorDomain}`,
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

const actorUsernameToAccount = async (username: string): Promise<CamelToSnake<mastodon.v1.Account> | undefined> => {
	const actorId = `https://${domain}/activitypub/u/${username}`;
	const [object, userInfoDoc] = await Promise.all([
		apex.store.getObject(actorId) as Promise<APActor>,
		UserInfos.doc(escapeFirestoreKey(actorId)).get(),
	]);
	if (object === undefined || !userInfoDoc.exists) {
		return undefined;
	}
	return actorObjectToAccount(object, userInfoDoc.data()!);
};

const noteObjectToStatus = (note: APNote, account: CamelToSnake<mastodon.v1.Account>): CamelToSnake<mastodon.v1.Status> => {
	const id = note.id!.split('/').pop()!;
	return {
		id,
		created_at: note.published!.toString(),
		edited_at: null,
		in_reply_to_id: null,
		in_reply_to_account_id: null,
		sensitive: false,
		spoiler_text: '',
		visibility: 'public',
		language: 'ja',
		uri: `https://${domain}/@${account.username}@${domain}/${id}`,
		url: `https://${domain}/@${account.username}@${domain}/${id}`,
		replies_count: 0,
		reblogs_count: 0,
		favourites_count: 0,
		reblogged: false,
		favourited: false,
		muted: false,
		bookmarked: false,
		pinned: false,
		content: Array.isArray(note.content) ? note.content[0] : note.content,
		reblog: null,
		application: {
			name: 'activitypub-firebase',
			website: `https://${domain}`,
		},
		account,
		media_attachments: [],
		mentions: [],
		tags: [],
		emojis: [],
		card: null,
		poll: null,
	};
};

const getAttributedTo = (object: APObject): string | undefined => {
	if (object.attributedTo === undefined) {
		return undefined;
	}

	if (Array.isArray(object.attributedTo)) {
		const [user] = object.attributedTo;
		if (typeof user === 'string') {
			return user;
		}
		return undefined;
	}

	if (typeof object.attributedTo === 'string') {
		return object.attributedTo;
	}

	return undefined;
};

const userIdsToAcconts = async (userIds: string[]): Promise<CamelToSnake<mastodon.v1.Account>[]> => {
	if (userIds.length === 0) {
		return [];
	}

	const [actorObjects, userInfos] = await Promise.all([
		apex.store.getObjects(userIds) as Promise<APActor[]>,
		UserInfos.where(firebase.firestore.FieldPath.documentId(), 'in', userIds.map(escapeFirestoreKey)).get(),
	]);

	const actorMap = new Map<string, APActor>(
		actorObjects.map((actor) => [actor.id!, actor]),
	);
	const userInfoMap = new Map<string, UserInfo>(
		userInfos.docs.map((doc) => [unescapeFirestoreKey(doc.id), doc.data()]),
	);

	return Promise.all(userIds.map((userId) => {
		const actor = actorMap.get(userId);
		assert(actor !== undefined, 'actor is undefined');

		const userInfo = userInfoMap.get(userId);

		return actorObjectToAccount(actor, userInfo);
	}));
};

const getAllNotes = async () => {
	const notes = (await apex.store.getObjectsByFieldValue('type', 'Note')) as APNote[];
	const validNotes = notes.filter((note) => getAttributedTo(note) !== undefined);
	const userIds = validNotes.map((note) => getAttributedTo(note)!);
	const accountsMap = new Map(zip(userIds, await userIdsToAcconts(userIds)));

	return Promise.all(validNotes.map((note) => {
		const attributedTo = getAttributedTo(note);
		assert(attributedTo !== undefined, 'attributedTo is undefined');

		const account = accountsMap.get(attributedTo);
		assert(account !== undefined, 'account is undefined');

		return noteObjectToStatus(note, account);
	}));
};

const getInboxId = (actor: APActor) => {
	if (Array.isArray(actor.inbox)) {
		return actor.inbox[0] as string;
	}
	if (typeof actor.inbox === 'string') {
		return actor.inbox;
	}
	throw new Error('inbox is not string');
};

const getFollowers = async (actor: APActor) => {
	const followStreams = await db.collection('streams')
		.where('type', '==', 'Follow')
		.where('object', 'array-contains', actor.id)
		.get();
	const unfollowStreams = await db.collection('streams')
		.where('_meta.collection', '==', getInboxId(actor))
		.where('type', '==', 'Undo')
		.where('_meta.objectType', '==', 'Follow')
		.get();

	const followCounter = new Counter<string>();

	for (const followStream of followStreams.docs) {
		const follow = followStream.data();
		const followActor = Array.isArray(follow.actor) ? follow.actor[0] : follow.actor;
		followCounter.increment(followActor);
	}

	for (const unfollowStream of unfollowStreams.docs) {
		const unfollow = unfollowStream.data();
		const unfollowActor = Array.isArray(unfollow.actor) ? unfollow.actor[0] : unfollow.actor;
		followCounter.increment(unfollowActor, -1);
	}

	const followerIds = Array.from(followCounter)
		.filter(([, count]) => count > 0)
		.map(([followerActor]) => followerActor);

	return userIdsToAcconts(followerIds);
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

const getAccount = (acct: string) => {
	const [username, lookupDomain = domain] = acct.split('@');

	if (lookupDomain !== domain) {
		throw new Error('Not implemented');
	}

	return actorUsernameToAccount(username);
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

	const account = await getAccount(acct);

	if (account === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	res.json(account);
});

router.get('/v1/accounts/:id/statuses', async (req, res) => {
	res.json(await getAllNotes());
});

router.get('/v1/accounts/:id/followers', async (req, res) => {
	const userInfo = await UserInfos.where('id', '==', req.params.id).get();

	if (userInfo.docs.length !== 1) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userId = unescapeFirestoreKey(userInfo.docs[0].id);
	const actorObject = await apex.store.getObject(userId) as (APActor | undefined);

	if (actorObject === undefined) {
		res.sendStatus(500);
		return;
	}

	res.json(await getFollowers(actorObject));
});

router.get('/v1/accounts/verify_credentials', authRequired, (req, res) => {
	res.json(res.locals.auth);
});

router.get('/v1/preferences', authRequired, (req, res) => {
	res.send({
		'posting:default:visibility': 'public',
		'posting:default:sensitive': false,
		'posting:default:language': 'ja',
		'reading:expand:media': 'show_all',
		'reading:expand:spoilers': true,
	});
});

router.get('/v1/push/subscription', authRequired, (req, res) => {
	res.status(404).json({
		error: 'Record not found',
	});
});

router.get('/v1/timelines/public', async (req, res) => {
	res.json(await getAllNotes());
});

router.get('/v1/timelines/home', authRequired, async (req, res) => {
	res.json(await getAllNotes());
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
