import assert from 'node:assert';
import crypto from 'node:crypto';
import { Request as OauthRequest, Response as OauthResponse } from '@node-oauth/oauth2-server';
import type { APObject as ApexObject } from 'activitypub-express';
import type { APNote, APActor, APObject } from 'activitypub-types';
import cors from 'cors';
import express from 'express';
import firebase from 'firebase-admin';
import { chunk, last, zip } from 'lodash-es';
import type { mastodon } from 'masto';
import { z } from 'zod';
import { apex } from '../activitypub.js';
import { domain, escapeFirestoreKey, mastodonDomain, unescapeFirestoreKey } from '../firebase.js';
import { metaIndexPath } from '../meta.js';
import { Clients, Streams, UserInfo, UserInfos } from '../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../store.js';
import type { CamelToSnake } from '../utils.js';
import { isAPActor, isAPNote, toIdArray, toStringValue } from '../utils.js';
import { instanceV1, instanceV2 } from './instanceInformation.js';
import { oauth } from './oauth.js';

const validScopes = [
	'follow',
	'push',
	'read',
	'read:accounts',
	'read:blocks',
	'read:blocks',
	'read:bookmarks',
	'read:favourites',
	'read:filters',
	'read:follows',
	'read:follows',
	'read:lists',
	'read:mutes',
	'read:mutes',
	'read:notifications',
	'read:search',
	'read:statuses',
	'write',
	'write:accounts',
	'write:blocks',
	'write:blocks',
	'write:bookmarks',
	'write:conversations',
	'write:favourites',
	'write:filters',
	'write:follows',
	'write:follows',
	'write:lists',
	'write:media',
	'write:mutes',
	'write:mutes',
	'write:notifications',
	'write:reports',
	'write:statuses',
];

const assertIsAPActor: (
	object: ApexObject | undefined,
) => asserts object is ApexObject & APActor = (object) => {
	assert(object !== undefined, 'object is undefined');
	assert(isAPActor(object), `object is not an actor: ${object.id}`);
};

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

export const actorObjectToAccount = async (
	actorObject: APActor,
	userInfo: UserInfo = externalUserInfo,
): Promise<CamelToSnake<mastodon.v1.Account>> => {
	// activitypub-types の APActor は icon/image を IconField|ImageField の union として定義するなど
	// ここでの緩いプロパティアクセスと厳密には一致しない。この不整合の解消は ADR-0022 の対象外
	// (apex 自体の型付けのみが対象) なので、ここでは toJSONLD 呼び出し以前と同じ緩さを維持する。
	const actor: any = await apex.toJSONLD(actorObject);
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

const actorUsernameToAccount = async (
	username: string,
): Promise<CamelToSnake<mastodon.v1.Account> | undefined> => {
	const actorId = `https://${domain}/activitypub/u/${username}`;
	const [object, userInfoDoc] = await Promise.all([
		apex.store.getObject(actorId),
		UserInfos.doc(escapeFirestoreKey(actorId)).get(),
	]);
	if (object === undefined || !userInfoDoc.exists) {
		return undefined;
	}
	assertIsAPActor(object);
	const userInfo = userInfoDoc.data();
	assert(userInfo !== undefined, 'userInfo is undefined');
	return actorObjectToAccount(object, userInfo);
};

export const noteObjectToStatus = (
	note: APNote,
	account: CamelToSnake<mastodon.v1.Account>,
): CamelToSnake<mastodon.v1.Status> => {
	assert(note.id !== undefined, 'note.id is undefined');
	assert(note.published !== undefined, 'note.published is undefined');
	const id = note.id.split('/').pop();
	assert(id !== undefined, 'id is undefined');
	return {
		id,
		created_at: note.published.toString(),
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
		content: toStringValue(note.content) ?? '',
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

const getAttributedTo = (object: APObject): string | undefined => toIdArray(object.attributedTo)[0];

const userIdsToAcconts = async (
	userIds: string[],
): Promise<CamelToSnake<mastodon.v1.Account>[]> => {
	if (userIds.length === 0) {
		return [];
	}

	const [actorObjects, userInfoDocsChunks] = await Promise.all([
		apex.store.getObjects(userIds),
		Promise.all(
			chunk(userIds.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT).map((idChunk) =>
				UserInfos.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
			),
		),
	]);

	const actorMap = new Map<string, APActor>(
		actorObjects.map((actor) => {
			assertIsAPActor(actor);
			return [actor.id, actor];
		}),
	);
	const userInfoMap = new Map<string, UserInfo>(
		userInfoDocsChunks.flatMap((userInfos) =>
			userInfos.docs.map((doc) => [unescapeFirestoreKey(doc.id), doc.data()] as const),
		),
	);

	return Promise.all(
		userIds.map((userId) => {
			const actor = actorMap.get(userId);
			assert(actor !== undefined, 'actor is undefined');

			const userInfo = userInfoMap.get(userId);

			return actorObjectToAccount(actor, userInfo);
		}),
	);
};

const getAllNotes = async () => {
	const notes = (await apex.store.getObjectsByFieldValue('type', 'Note')).filter(isAPNote);
	const validNotes = notes.filter((note) => getAttributedTo(note) !== undefined);
	const userIds = validNotes.map((note) => {
		const attributedTo = getAttributedTo(note);
		assert(attributedTo !== undefined, 'attributedTo is undefined');
		return attributedTo;
	});
	const accountsMap = new Map(zip(userIds, await userIdsToAcconts(userIds)));

	return Promise.all(
		validNotes.map((note) => {
			const attributedTo = getAttributedTo(note);
			assert(attributedTo !== undefined, 'attributedTo is undefined');

			const account = accountsMap.get(attributedTo);
			assert(account !== undefined, 'account is undefined');

			return noteObjectToStatus(note, account);
		}),
	);
};

const getInboxId = (actor: APActor) => {
	const inboxId = toIdArray(actor.inbox)[0];
	if (inboxId !== undefined) {
		return inboxId;
	}
	throw new Error('inbox is not string');
};

export const getFollowers = async (actor: APActor) => {
	assert(actor.id !== undefined, 'actor.id is undefined');

	// object/actor は IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうるため、生の
	// フィールドではなく denormalizations.ts が書き込む map 形式のインデックス `_meta.index.*`
	// を等価条件で引く(→ ADR-0021)。
	const followStreams = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('objects', actor.id), '==', true)
		.get();
	// 受信した Undo の object は、Mastodon のように Follow を丸ごと埋め込んでくる場合と
	// 素の IRI 文字列で届く場合がある。`_meta.objectType` による絞り込みは後者を取りこぼすため、
	// inbox の Undo をすべて取得し、打ち消された Follow の IRI で突き合わせる(→ ADR-0021)。
	const unfollowStreams = await Streams.where(
		metaIndexPath('collections', getInboxId(actor)),
		'==',
		true,
	)
		.where('type', '==', 'Undo')
		.get();

	const undoneFollowIds = new Set(
		unfollowStreams.docs.flatMap((unfollowStream) => toIdArray(unfollowStream.data().object)),
	);

	const followerIds = new Set<string>();

	for (const followStream of followStreams.docs) {
		const follow = followStream.data();
		if (undoneFollowIds.has(follow.id)) {
			continue;
		}
		const followActor = toIdArray(follow.actor)[0];
		if (followActor !== undefined) {
			followerIds.add(followActor);
		}
	}

	return userIdsToAcconts(Array.from(followerIds));
};

const authRequired = async (
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) => {
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

router.use(
	'/',
	cors({
		origin: true,
		methods: ['GET', 'POST'],
		allowedHeaders: ['Authorization', 'Content-Type'],
	}),
);

router.get('/v1/instance', (req, res) => {
	res.json(instanceV1);
});

router.get('/v2/instance', (req, res) => {
	res.json(instanceV2);
});

export const accountLookupQuerySchema = z.object({
	acct: z.string().min(1),
});

export const accountParamsSchema = z.object({
	id: z.string().min(1),
});

export const createAppBodySchema = z.object({
	client_name: z.string().min(1),
	redirect_uris: z.string().min(1),
	scopes: z
		.string()
		.default('read')
		.refine((scopes) => scopes.split(' ').every((scope) => validScopes.includes(scope)), {
			message: 'Invalid scope included',
		}),
	website: z.string().default(''),
});

router.get('/v1/accounts/lookup', async (req, res) => {
	const parsedQuery = accountLookupQuerySchema.safeParse(req.query);
	if (!parsedQuery.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const account = await getAccount(parsedQuery.data.acct);

	if (account === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	res.json(account);
});

router.get('/v1/accounts/:id/statuses', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	res.json(await getAllNotes());
});

router.get('/v1/accounts/:id/followers', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfo = await UserInfos.where('id', '==', parsedParams.data.id).get();

	if (userInfo.docs.length !== 1) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userId = unescapeFirestoreKey(userInfo.docs[0].id);
	const actorObject = await apex.store.getObject(userId);

	if (actorObject === undefined) {
		res.sendStatus(500);
		return;
	}
	assertIsAPActor(actorObject);

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
	const parsedBody = createAppBodySchema.safeParse(req.body);
	if (!parsedBody.success) {
		res.status(400).send('Bad request');
		return;
	}

	const { client_name: clientName, redirect_uris: redirectUris, scopes, website } = parsedBody.data;

	const scopeSet = new Set<string>(scopes.split(' '));

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
