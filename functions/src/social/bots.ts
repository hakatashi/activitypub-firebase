import assert from 'node:assert';
import { randomBytes } from 'node:crypto';
import { apex } from '../apex.js';
import type { APObject } from '../apex/index.js';
import {
	db,
	escapeFirestoreKey,
	instanceConfig,
	toFirestoreKey,
	unescapeFirestoreKey,
} from '../firebase.js';
import { LOCAL_USERNAME, localActorIri } from '../localActor.js';
import { AccessTokens, UserInfos } from '../schema.js';
import type { FollowPolicy, UserInfo } from '../schema.js';

// ボット actor の作成と管理 (→ ADR-0149)、フォローの承認ポリシー (→ ADR-0150)。

export const BOT_USERNAME_PATTERN = /^[a-z0-9_]{1,30}$/u;

// オペレータートークンの `user.userId`。Firebase Auth の uid とは衝突しない (→ ADR-0151)。
export const BOT_OPERATOR_UID = 'bot-operator';
const BOT_OPERATOR_CLIENT_ID = 'bot-operator';
// ADR-0133 と同じく無期限にする。
const NEVER_EXPIRES_AT = new Date('9999-12-31T23:59:59.999Z');

export class BotError extends Error {
	readonly status: number;

	constructor(message: string, status: number = 400) {
		super(message);
		this.name = 'BotError';
		this.status = status;
	}
}

export interface Bot {
	username: string;
	actor: string;
	followPolicy: FollowPolicy;
}

export interface CreateBotInput {
	username: string;
	displayName?: string | undefined;
	summary?: string | undefined;
	iconUrl?: string | undefined;
	followPolicy?: FollowPolicy | undefined;
}

const assertBotsEnabled = () => {
	if (!instanceConfig.bots.enabled) {
		throw new BotError('Bots are not enabled on this instance', 404);
	}
};

export const defaultFollowPolicy = (): FollowPolicy => ({
	mode: 'allowlist',
	allowlist: [...instanceConfig.bots.defaultFollowAllowlist],
});

// ポリシーを持たない actor (主 actor) は全員を承認する。
export const isFollowAllowed = (policy: FollowPolicy | undefined, followerId: string): boolean =>
	policy === undefined || policy.mode === 'open' || policy.allowlist.includes(followerId);

export const getFollowPolicy = async (actorId: string): Promise<FollowPolicy | undefined> =>
	(await UserInfos.doc(escapeFirestoreKey(actorId)).get()).data()?.followPolicy;

const toBot = (actor: string, userInfo: UserInfo): Bot | undefined => {
	if (!userInfo.bot || userInfo.followPolicy === undefined) {
		return undefined;
	}
	const username = actor.slice(actor.lastIndexOf('/') + 1);
	return { username, actor, followPolicy: userInfo.followPolicy };
};

export const createBot = async (input: CreateBotInput): Promise<Bot> => {
	assertBotsEnabled();
	const { username } = input;
	if (!BOT_USERNAME_PATTERN.test(username)) {
		throw new BotError('username must match /^[a-z0-9_]{1,30}$/');
	}
	if (username === LOCAL_USERNAME) {
		throw new BotError(`${username} is reserved`, 409);
	}
	const actorId = localActorIri(username);
	if ((await apex.store.getObject(actorId)) !== undefined) {
		throw new BotError(`${username} already exists`, 409);
	}

	const followPolicy = input.followPolicy ?? defaultFollowPolicy();
	const icon = input.iconUrl === undefined ? undefined : { type: 'Image', url: input.iconUrl };
	const actor = await apex.createActor(
		username,
		input.displayName ?? username,
		input.summary ?? '',
		icon,
		'Service',
	);
	actor.manuallyApprovesFollowers = followPolicy.mode === 'allowlist';

	const userInfoRef = UserInfos.doc(escapeFirestoreKey(actorId));
	await db.runTransaction(async (transaction) => {
		if ((await transaction.get(userInfoRef)).exists) {
			throw new BotError(`${username} already exists`, 409);
		}
		const nextUserId = (await transaction.get(UserInfos.count())).data().count + 1;
		transaction.set(userInfoRef, {
			id: nextUserId.toString(),
			uid: null,
			locked: followPolicy.mode === 'allowlist',
			bot: true,
			created_at: new Date().toISOString(),
			followers_count: 0,
			following_count: 0,
			statuses_count: 0,
			last_status_at: '',
			emojis: [],
			fields: [],
			roles: [],
			source: {
				privacy: followPolicy.mode === 'allowlist' ? 'private' : 'public',
				sensitive: false,
				language: null,
			},
			followPolicy,
		});
	});
	await apex.store.setup(actor);

	return { username, actor: actorId, followPolicy };
};

export const listBots = async (): Promise<Bot[]> => {
	assertBotsEnabled();
	const docs = await UserInfos.where('bot', '==', true).get();
	return docs.docs.flatMap((doc) => {
		const bot = toBot(unescapeFirestoreKey(toFirestoreKey(doc.id)), doc.data());
		return bot === undefined ? [] : [bot];
	});
};

export const getBot = async (username: string): Promise<Bot | undefined> => {
	if (!BOT_USERNAME_PATTERN.test(username)) {
		return undefined;
	}
	const actorId = localActorIri(username);
	const userInfo = (await UserInfos.doc(escapeFirestoreKey(actorId)).get()).data();
	return userInfo === undefined ? undefined : toBot(actorId, userInfo);
};

// ポリシーを変える。承認済みのフォロワーは外さない。
// manuallyApprovesFollowers が変わったら actor の Update を配送する (→ ADR-0150 決定6)。
export const updateBotFollowPolicy = async (
	username: string,
	followPolicy: FollowPolicy,
): Promise<Bot> => {
	assertBotsEnabled();
	const bot = await getBot(username);
	if (bot === undefined) {
		throw new BotError(`${username} not found`, 404);
	}
	const locked = followPolicy.mode === 'allowlist';
	await UserInfos.doc(escapeFirestoreKey(bot.actor)).update({ followPolicy, locked });

	const actor = await apex.store.getObject(bot.actor);
	const actorWithMeta = await apex.store.getObject(bot.actor, true);
	assert(actor !== undefined, 'bot actor not found');
	assert(actorWithMeta !== undefined, 'bot actor with meta not found');
	if (actor.manuallyApprovesFollowers !== locked) {
		const updated: APObject = { ...actor, manuallyApprovesFollowers: locked };
		await apex.store.saveObject(updated);
		await apex.publishUpdate(actorWithMeta, updated);
	}
	return { ...bot, followPolicy };
};

export type ResolveBotUserInfoResult =
	| { status: 'ok'; actorId: string; userInfo: UserInfo }
	| { status: 'not-found' }
	| { status: 'forbidden' };

// オペレータートークンで操作するボットを `X-Bot-Account` の値から引く (→ ADR-0151)。
// ボットでないローカル actor (主 actor) は forbidden にする。
export const resolveBotUserInfo = async (
	username: string | undefined,
): Promise<ResolveBotUserInfoResult> => {
	if (!instanceConfig.bots.enabled || username === undefined) {
		return { status: 'not-found' };
	}
	const normalized = username.trim().toLowerCase();
	if (!BOT_USERNAME_PATTERN.test(normalized)) {
		return { status: 'not-found' };
	}
	const actorId = localActorIri(normalized);
	const userInfo = (await UserInfos.doc(escapeFirestoreKey(actorId)).get()).data();
	if (userInfo === undefined) {
		return { status: 'not-found' };
	}
	if (!userInfo.bot) {
		return { status: 'forbidden' };
	}
	return { status: 'ok', actorId, userInfo };
};

// オペレータートークンを発行する。値は戻り値でしか分からない (→ ADR-0151)。
export const issueBotOperatorToken = async (): Promise<string> => {
	assertBotsEnabled();
	const accessToken = randomBytes(32).toString('hex');
	await AccessTokens.add({
		accessToken,
		accessTokenExpiresAt: NEVER_EXPIRES_AT,
		scope: ['read', 'write'],
		client: { id: BOT_OPERATOR_CLIENT_ID, grants: [] },
		user: { userId: BOT_OPERATOR_UID },
	});
	return accessToken;
};

// 発行済みのオペレータートークンをすべて失効させ、件数を返す。
export const revokeBotOperatorTokens = async (): Promise<number> => {
	const docs = await AccessTokens.where('user.userId', '==', BOT_OPERATOR_UID).get();
	await Promise.all(docs.docs.map((doc) => doc.ref.delete()));
	return docs.size;
};
