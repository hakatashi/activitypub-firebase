import assert from 'node:assert';
import {
	OAuthError,
	Request as OauthRequest,
	Response as OauthResponse,
} from '@node-oauth/oauth2-server';
import type { APActor } from 'activitypub-types';
import type express from 'express';
import { apex } from '../../apex.js';
import { toFirestoreKey, unescapeFirestoreKey } from '../../firebase.js';
import { UserInfos } from '../../schema.js';
import { oauth } from '../oauth.js';
import { assertIsAPActor } from '../presenters/account.js';

import { HttpError } from './errors.js';
import type { UserInfo } from '../../schema.js';
import './locals.js';

export const validScopes = [
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

export class AuthenticationError extends HttpError {
	constructor(message = 'This method requires an authenticated user', statusCode = 401) {
		super(statusCode, message);
		this.name = 'AuthenticationError';
	}
}

export const getAuthActorId = (res: express.Response): string => {
	const actorId = res.locals.actorId;
	assert(typeof actorId === 'string' && actorId.length > 0, 'res.locals.actorId is not set');
	return actorId;
};

export const getAuthUserInfo = (res: express.Response): UserInfo => {
	const auth = res.locals.auth;
	assert(auth !== undefined, 'res.locals.auth is not set');
	return auth;
};

// OAuth トークンから、ログイン中のローカル actor の IRI と UserInfo を引く。
const resolveAuth = async (req: express.Request, res: express.Response) => {
	const request = new OauthRequest(req);
	const response = new OauthResponse(res);
	let token;
	try {
		token = await oauth.authenticate(request, response);
	} catch (error) {
		if (response.headers) {
			res.set(response.headers);
		}
		throw error;
	}

	const uid = token.user?.userId;
	if (typeof uid !== 'string') {
		throw new AuthenticationError('This method requires an authenticated user', 401);
	}

	const userInfoDocs = await UserInfos.where('uid', '==', uid).get();
	if (userInfoDocs.empty) {
		throw new AuthenticationError('This method requires an authenticated user', 401);
	}
	assert(userInfoDocs.size === 1, `Multiple UserInfos found for uid: ${uid}`);

	const userInfoDoc = userInfoDocs.docs[0];
	assert(userInfoDoc !== undefined);

	return {
		userInfo: userInfoDoc.data(),
		actorId: unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id)),
		scope: token.scope,
	};
};

export const authRequired = async (
	req: express.Request,
	res: express.Response,
	next: express.NextFunction,
) => {
	try {
		const { userInfo, actorId, scope } = await resolveAuth(req, res);
		// eslint-disable-next-line require-atomic-updates
		res.locals.auth = userInfo;
		// eslint-disable-next-line require-atomic-updates
		res.locals.actorId = actorId;
		// eslint-disable-next-line require-atomic-updates
		res.locals.scope = scope;

		next();
	} catch (error) {
		if (error instanceof OAuthError || error instanceof AuthenticationError) {
			const status = (error as { statusCode?: number }).statusCode ?? 401;
			res.status(status).json({
				error: error.message,
			});
			return;
		}
		next(error);
	}
};

// Mastodon と同じく、`write:statuses` のような細分化スコープはその親 (`write`) でも満たされる。
export const hasScope = (granted: unknown, required: string) => {
	const grantedScopes = (
		Array.isArray(granted) ? granted : String(granted ?? '').split(' ')
	).filter((scope): scope is string => typeof scope === 'string');
	const parent = required.split(':')[0];
	return grantedScopes.some((scope) => scope === required || scope === parent);
};

// `authRequired` の後に置く。
export const scopeRequired =
	(required: string) =>
	(req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (!hasScope(res.locals.scope, required)) {
			res.status(403).json({
				error: 'This action is outside the authorized scopes',
			});
			return;
		}
		next();
	};

export const getLocalActor = async (actorId: string): Promise<APActor> => {
	const actor = await apex.store.getObject(actorId);
	assert(actor !== undefined, 'actor is undefined');
	assertIsAPActor(actor);
	return actor;
};

// 認証は任意のエンドポイント用。トークンが無い・無効なら未認証の閲覧者として扱う。
export const getOptionalViewer = async (
	req: express.Request,
	res: express.Response,
): Promise<APActor | undefined> => {
	if (req.headers.authorization === undefined) {
		return undefined;
	}
	try {
		const { actorId } = await resolveAuth(req, res);
		return await getLocalActor(actorId);
	} catch {
		return undefined;
	}
};
