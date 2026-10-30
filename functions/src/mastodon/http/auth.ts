import assert from 'node:assert';
import {
	OAuthError,
	Request as OauthRequest,
	Response as OauthResponse,
} from '@node-oauth/oauth2-server';
import type { APActor } from 'activitypub-types';
import type express from 'express';
import { apex } from '../../apex.js';
import type { APObject as ApexObject } from '../../apex/index.js';
import { toFirestoreKey, unescapeFirestoreKey } from '../../firebase.js';
import { UserInfos } from '../../schema.js';
import { BOT_OPERATOR_UID, resolveBotUserInfo } from '../../social/bots.js';
import { oauth } from '../oauth.js';
import { assertIsAPActor } from '../presenters/account.js';

import { HttpError } from './errors.js';
import { clonePlain, createTtlCache } from './instanceCache.js';
import type { UserInfo } from '../../schema.js';
import './locals.js';

export const validScopes = [
	'follow',
	'push',
	'read',
	'read:accounts',
	'read:blocks',
	'read:bookmarks',
	'read:favourites',
	'read:filters',
	'read:follows',
	'read:lists',
	'read:mutes',
	'read:notifications',
	'read:search',
	'read:statuses',
	'write',
	'write:accounts',
	'write:blocks',
	'write:bookmarks',
	'write:conversations',
	'write:favourites',
	'write:filters',
	'write:follows',
	'write:lists',
	'write:media',
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

// uid → UserInfo と actor の IRI、actor の IRI → 閲覧者の actor (`_meta` 込み) のインスタンス内キャッシュ
// (→ ADR-0169)。返すときは複製して、呼び出し側の書き換えがキャッシュに残らないようにする。
const AUTH_CACHE_MAX_ENTRIES = 64;
const AUTH_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

const userInfoByUidCache = createTtlCache<{ userInfo: UserInfo; actorId: string }>({
	maxEntries: AUTH_CACHE_MAX_ENTRIES,
	maxAgeMs: AUTH_CACHE_MAX_AGE_MS,
});
const viewerActorCache = createTtlCache<ApexObject & APActor>({
	maxEntries: AUTH_CACHE_MAX_ENTRIES,
	maxAgeMs: AUTH_CACHE_MAX_AGE_MS,
});

// 閲覧者のプロフィールや設定を変えるルートが呼ぶ。同じインスタンスのキャッシュだけを消す。
export const invalidateViewerCache = (actorId: string) => {
	userInfoByUidCache.deleteWhere((entry) => entry.actorId === actorId);
	viewerActorCache.delete(actorId);
};

export const clearAuthCache = () => {
	userInfoByUidCache.clear();
	viewerActorCache.clear();
};

const findUserInfoByUid = async (uid: string) => {
	const cached = userInfoByUidCache.get(uid);
	if (cached !== undefined) {
		return clonePlain(cached);
	}

	const userInfoDocs = await UserInfos.where('uid', '==', uid).get();
	if (userInfoDocs.empty) {
		return undefined;
	}
	assert(userInfoDocs.size === 1, `Multiple UserInfos found for uid: ${uid}`);

	const userInfoDoc = userInfoDocs.docs[0];
	assert(userInfoDoc !== undefined);

	const entry = {
		userInfo: userInfoDoc.data(),
		actorId: unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id)),
	};
	userInfoByUidCache.set(uid, clonePlain(entry));
	return entry;
};

// `fresh` は actor を書き換えて保存するルート用。古い actor を書き戻さないように、キャッシュを使わない。
export const getViewerActor = async (
	actorId: string,
	{ fresh = false }: { fresh?: boolean } = {},
): Promise<ApexObject & APActor> => {
	const cached = fresh ? undefined : viewerActorCache.get(actorId);
	if (cached !== undefined) {
		return clonePlain(cached);
	}
	const actor = await apex.store.getObject(actorId, true);
	assert(actor !== undefined, 'actor is undefined');
	assertIsAPActor(actor);
	viewerActorCache.set(actorId, clonePlain(actor));
	return actor;
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

	// オペレータートークンは X-Bot-Account のボットとして扱う (→ ADR-0151)。
	if (uid === BOT_OPERATOR_UID) {
		const result = await resolveBotUserInfo(req.get('x-bot-account'));
		if (result.status !== 'ok') {
			throw new AuthenticationError(
				result.status === 'forbidden'
					? 'X-Bot-Account is not a bot'
					: 'X-Bot-Account header must name a bot on this instance',
				result.status === 'forbidden' ? 403 : 401,
			);
		}
		return { userInfo: result.userInfo, actorId: result.actorId, scope: token.scope };
	}

	const found = await findUserInfoByUid(uid);
	if (found === undefined) {
		throw new AuthenticationError('This method requires an authenticated user', 401);
	}

	return { ...found, scope: token.scope };
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

// Mastodon の `authorize_if_got_token!` 相当。トークンがあれば `authRequired` と `scopeRequired` を課し、
// 無ければ未認証のまま通す。無効なトークンは 401 になる。
export const authIfPresent =
	(required: string) =>
	async (req: express.Request, res: express.Response, next: express.NextFunction) => {
		if (req.headers.authorization === undefined) {
			next();
			return;
		}
		await authRequired(req, res, (error?: unknown) => {
			if (error !== undefined) {
				next(error);
				return;
			}
			scopeRequired(required)(req, res, next);
		});
	};

export const getLocalActor = async (actorId: string): Promise<APActor> => {
	const actor = await getViewerActor(actorId);
	delete actor._meta;
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
