import assert from 'node:assert';
import type { APObject as ApexObject, JsonLdActor } from '../../apex/index.js';
import type { APActor } from 'activitypub-types';
import firebase from 'firebase-admin';
import { chunk, last, omit, uniq } from 'lodash-es';
import type { mastodon } from 'masto';
import { apex } from '../../apex.js';
import {
	getFollowFlags,
	getFollowersPageEntries,
	getFollowingPageEntries,
} from '../../social/follows.js';
import { getReactionPageEntries } from '../../social/reactions.js';
import {
	domain,
	escapeFirestoreKey,
	mastodonDomain,
	toFirestoreKey,
	unescapeFirestoreKey,
} from '../../firebase.js';
import { getIriByMastodonId, getMastodonIds, getOrAssignMastodonId } from '../../mastodonId.js';
import { htmlToPlainText } from '../../notes.js';
import { defaultAvatarUrl, defaultHeaderUrl } from '../defaultImages.js';
import { Objects, UserInfo, UserInfos } from '../../schema.js';
import type { DefaultPrivacy, ReactionKind } from '../../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../../store/limits.js';
import type { CamelToSnake } from '../../utils.js';
import { isAPActor } from '../../utils.js';
import type { PageParams } from '../pagination.js';
import { getObjects } from '../../store/objects.js';
import {
	readRemoteActorStats,
	requestRemoteActorRefreshIfStale,
} from '../../social/remoteActorCounts.js';
import { requestRemoteActorResolution } from '../../social/remoteActorResolution.js';

export const assertIsAPActor: (
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

// リモート actor の `published` を Mastodon と同じく UTC の 0 時に丸める (→ ADR-0104)。
const toCreatedAt = (published: unknown) => {
	const value = Array.isArray(published) ? published[0] : published;
	if (typeof value !== 'string') {
		return undefined;
	}
	const time = Date.parse(value);
	return Number.isNaN(time)
		? undefined
		: `${new Date(time).toISOString().slice(0, 10)}T00:00:00.000Z`;
};

// リモート actor の件数などは actor の `_meta` に保存したものを読むだけで、外部へは取りに行かない
// (→ ADR-0104)。`actorObject` に `_meta` が付いていなければ 0 になる。
const remoteUserInfo = (actorObject: ApexObject | APActor): UserInfo => {
	const stats = readRemoteActorStats((actorObject as ApexObject)._meta);
	return {
		...externalUserInfo,
		created_at: toCreatedAt(actorObject.published) ?? externalUserInfo.created_at,
		followers_count: stats.followersCount ?? 0,
		following_count: stats.followingCount ?? 0,
		statuses_count: stats.statusesCount ?? 0,
		last_status_at: stats.lastStatusAt ?? '',
	};
};

const nonEmptyString = (value: unknown) =>
	typeof value === 'string' && value !== '' ? value : undefined;

export const actorObjectToAccount = async (
	actorObject: APActor,
	userInfo?: UserInfo,
	id?: string,
): Promise<CamelToSnake<mastodon.v1.Account>> => {
	// activitypub-types の APActor は icon/image を IconField|ImageField の union として定義するなど
	// ここでの緩いプロパティアクセスと厳密には一致しない。この不整合の解消は ADR-0022 の対象外
	// (apex 自体の型付けのみが対象) なので、ここでは toJSONLD 呼び出し以前と同じ緩さを維持する。
	const actor = await apex.toJSONLD<JsonLdActor>(omit(actorObject, '_meta') as APActor);
	const username = actor.preferredUsername ?? last(actor.id.split('/')) ?? '';
	const actorDomain = new URL(actor.id).host;
	const isLocal = actorDomain === domain;

	const baseUserInfo = userInfo ?? remoteUserInfo(actorObject);
	// ローカルは Elk のプロフィールへ誘導する (→ ADR-0004)。リモートは相手サーバーのプロフィール URL。
	let url = actor.id;
	if (isLocal) {
		url = `https://elk.zone/${mastodonDomain}/@${username}@${domain}`;
	} else if (typeof actor.url === 'string') {
		url = actor.url;
	}
	// 画像がなければ既定画像の URL を返す。空文字列だとクライアントが壊れた画像を出す (→ ADR-0109)。
	const avatar = nonEmptyString(actor.icon?.url) ?? defaultAvatarUrl;
	const header = nonEmptyString(actor.image?.url) ?? defaultHeaderUrl;
	const accountId =
		id ?? userInfo?.id ?? (await getOrAssignMastodonId(actor.id, actorObject.published));

	return {
		...omit(baseUserInfo, 'source'),
		id: accountId,
		username,
		acct: isLocal ? username : `${username}@${actorDomain}`,
		display_name: actor.name ?? '',
		url,
		avatar,
		avatar_static: avatar,
		header,
		header_static: header,
		note: actor.summary ?? '',
		discoverable: actor.discoverable ?? false,
	};
};

export interface CredentialAccountSource {
	privacy: string;
	sensitive: boolean;
	language: string;
	note: string;
	fields: CamelToSnake<mastodon.v1.AccountField>[];
	follow_requests_count: number;
}

export interface RoleEntity {
	id: string;
	name: string;
	permissions: string;
	color: string;
	highlighted: boolean;
}

export type CredentialAccountEntity = CamelToSnake<mastodon.v1.Account> & {
	source: CredentialAccountSource;
	role: RoleEntity;
};

export const defaultRole: RoleEntity = {
	id: '-99',
	name: '',
	permissions: '0',
	color: '',
	highlighted: false,
};

export interface ResolvedAccountSource {
	privacy: DefaultPrivacy;
	sensitive: boolean;
	language: string;
}

// 保存された投稿の既定値に、未設定の項目の既定値を補う (→ ADR-0105)。
export const resolveAccountSource = (userInfo: UserInfo): ResolvedAccountSource => ({
	privacy: userInfo.source?.privacy ?? (userInfo.locked ? 'private' : 'public'),
	sensitive: userInfo.source?.sensitive ?? false,
	language: userInfo.source?.language ?? 'ja',
});

export const accountToCredentialAccount = (
	account: CamelToSnake<mastodon.v1.Account>,
	userInfo: UserInfo,
): CredentialAccountEntity => ({
	...account,
	source: {
		...resolveAccountSource(userInfo),
		note: htmlToPlainText(account.note),
		fields: userInfo.fields ?? [],
		follow_requests_count: 0,
	},
	role: defaultRole,
});

export type RelationshipEntity = CamelToSnake<mastodon.v1.Relationship> & {
	muting_expires_at?: string | null;
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

// アカウント IRI (ローカル/リモート) の配列を受け取り、IRI → Account ID の Map を返す (→ ADR-0069)。
// ローカルアカウント (UserInfos があるもの) は UserInfo.id ('1' 等) を返し、
// リモートアカウント (UserInfos がないもの) は mastodonIdsByIri の Snowflake ID を返す (未採番なら採番する)。
export const resolveAccountIds = async (iris: string[]): Promise<Map<string, string>> => {
	const uniqIris = uniq(iris).filter((iri) => iri.length > 0);
	const result = new Map<string, string>();
	if (uniqIris.length === 0) {
		return result;
	}

	const idChunks = chunk(uniqIris.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT);
	const userInfoDocsChunks = await Promise.all(
		idChunks.map((idChunk) =>
			UserInfos.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
		),
	);

	for (const chunkSnap of userInfoDocsChunks) {
		for (const doc of chunkSnap.docs) {
			const data = doc.data();
			const actorId = unescapeFirestoreKey(toFirestoreKey(doc.id));
			result.set(actorId, data.id);
		}
	}

	const remoteIris = uniqIris.filter((iri) => !result.has(iri));
	if (remoteIris.length > 0) {
		const mastodonIds = await getMastodonIds(
			remoteIris.map((iri) => ({ iri, published: undefined })),
		);
		for (const [iri, id] of mastodonIds) {
			result.set(iri, id);
		}
	}

	return result;
};

// Account ID (ローカルの UserInfo.id またはリモートの Snowflake ID) から actor IRI を解決する。
export const resolveActorIriByAccountId = async (
	accountId: string,
): Promise<string | undefined> => {
	const userInfoSnap = await UserInfos.where('id', '==', accountId).limit(1).get();
	if (!userInfoSnap.empty) {
		const doc = userInfoSnap.docs[0]!;
		return unescapeFirestoreKey(toFirestoreKey(doc.id));
	}
	return getIriByMastodonId(accountId);
};

export const userIdsToAccountsMap = async (
	userIds: string[],
	knownAccountIds?: Map<string, string>,
): Promise<Map<string, CamelToSnake<mastodon.v1.Account>>> => {
	const uniqUserIds = uniq(userIds).filter((id) => id.length > 0);
	if (uniqUserIds.length === 0) {
		return new Map();
	}

	const [actorObjects, userInfoDocsChunks, accountIds] = await Promise.all([
		// リモート actor の件数を `_meta` から読むため (→ ADR-0104)。
		getObjects(uniqUserIds, true),
		Promise.all(
			chunk(uniqUserIds.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT).map((idChunk) =>
				UserInfos.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
			),
		),
		knownAccountIds ?? resolveAccountIds(uniqUserIds),
	]);

	const actorMap = new Map<string, APActor>();
	for (const actor of actorObjects) {
		if (isAPActor(actor)) {
			actorMap.set(actor.id, actor);
		}
	}

	const userInfoMap = new Map<string, UserInfo>(
		userInfoDocsChunks.flatMap((userInfos) =>
			userInfos.docs.map(
				(doc) => [unescapeFirestoreKey(toFirestoreKey(doc.id)), doc.data()] as const,
			),
		),
	);

	// `objects` に無かった actor は取得をタスクに頼み、今回は飛ばす (→ ADR-0099、ADR-0106)。
	const fetchedIds = new Set(actorObjects.map((object) => String(object.id)));
	const missingUserIds = uniqUserIds.filter((userId) => !fetchedIds.has(userId));

	const resultMap = new Map<string, CamelToSnake<mastodon.v1.Account>>();
	await Promise.all([
		requestRemoteActorResolution(missingUserIds),
		...uniqUserIds.map(async (userId) => {
			const actor = actorMap.get(userId);
			if (actor === undefined) {
				return;
			}

			const userInfo = userInfoMap.get(userId);
			const accountId = accountIds.get(userId);

			const account = await actorObjectToAccount(actor, userInfo, accountId);
			resultMap.set(userId, account);
		}),
	]);

	return resultMap;
};

export const userIdsToAccounts = async (
	userIds: string[],
	knownAccountIds?: Map<string, string>,
): Promise<CamelToSnake<mastodon.v1.Account>[]> => {
	const accountsMap = await userIdsToAccountsMap(userIds, knownAccountIds);
	return userIds.flatMap((userId) => {
		const account = accountsMap.get(userId);
		return account === undefined ? [] : [account];
	});
};

export const FOLLOWERS_PAGE_LIMITS = { defaultLimit: 40, maxLimit: 80 };

// カーソルは Follow アクティビティの Mastodon ID (Mastodon の follow 行 ID に相当。→ ADR-0062)。
// 返す `cursorIds` は `accounts` と同じ並び (新しい順)。
export const getFollowersPage = async (
	actor: APActor,
	page: PageParams = { limit: FOLLOWERS_PAGE_LIMITS.defaultLimit },
) => {
	const pageEntries = await getFollowersPageEntries(actor, page);
	const accountsMap = await userIdsToAccountsMap(pageEntries.map((entry) => entry.actorIri));
	const validEntries = pageEntries.filter((entry) => accountsMap.has(entry.actorIri));
	return {
		accounts: validEntries.map((entry) => accountsMap.get(entry.actorIri)!),
		cursorIds: validEntries.map((entry) => entry.cursorId),
	};
};

export const getFollowers = async (actor: APActor, page?: PageParams) =>
	(await getFollowersPage(actor, page)).accounts;

// カーソルは Follow アクティビティの Mastodon ID (→ ADR-0062)。
// 返す `cursorIds` は `accounts` と同じ並び (新しい順)。
export const getFollowingPage = async (
	actor: APActor,
	page: PageParams = { limit: FOLLOWERS_PAGE_LIMITS.defaultLimit },
) => {
	const pageEntries = await getFollowingPageEntries(actor, page);
	const accountsMap = await userIdsToAccountsMap(pageEntries.map((entry) => entry.actorIri));
	const validEntries = pageEntries.filter((entry) => accountsMap.has(entry.actorIri));
	return {
		accounts: validEntries.map((entry) => accountsMap.get(entry.actorIri)!),
		cursorIds: validEntries.map((entry) => entry.cursorId),
	};
};

// Status をお気に入り / ブーストしたアカウントの 1 ページ (→ ADR-0101)。
// カーソルはアクティビティの Mastodon ID。actor が引けず飛ばしたものも `cursorIds` に含め、
// 次のページで読み直さないようにする。`cursorIds` は新しい順。
export const getReactedByPage = async (noteIri: string, kind: ReactionKind, page: PageParams) => {
	const pageEntries = await getReactionPageEntries(noteIri, kind, page);
	const accountsMap = await userIdsToAccountsMap(pageEntries.map((entry) => entry.actorIri));
	return {
		accounts: pageEntries.flatMap((entry) => {
			const account = accountsMap.get(entry.actorIri);
			return account === undefined ? [] : [account];
		}),
		cursorIds: pageEntries.map((entry) => entry.cursorId),
	};
};

export const getRelationships = async (
	viewer: APActor,
	accountIds: string[],
): Promise<RelationshipEntity[]> => {
	if (accountIds.length === 0) {
		return [];
	}

	const userInfoDocsChunks = await Promise.all(
		chunk(accountIds, FIRESTORE_IN_QUERY_LIMIT).map((chunkIds) =>
			UserInfos.where('id', 'in', chunkIds).get(),
		),
	);
	const targetActorMap = new Map<string, string>();
	for (const chunkSnap of userInfoDocsChunks) {
		for (const doc of chunkSnap.docs) {
			const data = doc.data();
			const actorId = unescapeFirestoreKey(toFirestoreKey(doc.id));
			targetActorMap.set(data.id, actorId);
		}
	}
	for (const id of accountIds) {
		if (!targetActorMap.has(id)) {
			const iri = await getIriByMastodonId(id);
			if (iri !== undefined) {
				targetActorMap.set(id, iri);
			}
		}
	}

	const targets = accountIds.flatMap((id) => {
		const targetActorId = targetActorMap.get(id);
		return targetActorId === undefined ? [] : [{ id, targetActorId }];
	});
	const flags = await getFollowFlags(
		viewer,
		targets.map(({ targetActorId }) => targetActorId),
	);

	const results: RelationshipEntity[] = [];
	targets.forEach(({ id }, index) => {
		const flag = flags[index];
		assert(flag !== undefined);
		results.push({
			id,
			following: flag.following,
			showing_reblogs: flag.following,
			notifying: false,
			languages: [],
			followed_by: flag.followedBy,
			blocking: false,
			blocked_by: false,
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
			requested: flag.requested,
			requested_by: false,
			domain_blocking: false,
			endorsed: false,
			note: '',
		});
	});

	return results;
};

export interface ResolvedAccountActor {
	actor: ApexObject & APActor;
	userInfo?: UserInfo;
}

export const resolveAccountActor = async (
	id: string,
): Promise<ResolvedAccountActor | undefined> => {
	const userInfoSnap = await UserInfos.where('id', '==', id).get();
	const userInfoDoc = userInfoSnap.docs[0];
	if (userInfoDoc !== undefined) {
		const actorId = unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id));
		const actor = await apex.store.getObject(actorId);
		if (actor === undefined) {
			return undefined;
		}
		assertIsAPActor(actor);
		return { actor, userInfo: userInfoDoc.data() };
	}

	const iri = await getIriByMastodonId(id);
	if (iri !== undefined) {
		// リモート actor の件数を `_meta` から読むため (→ ADR-0104)。
		const object = await apex.store.getObject(iri, true);
		if (object !== undefined && isAPActor(object)) {
			assertIsAPActor(object);
			return { actor: object };
		}
	}

	return undefined;
};

// 手元にキャッシュ済みのリモート actor を acct で引く。WebFinger で取りに行くことはしない (→ ADR-0073)。
// inbox で受けた actor は preferredUsername が配列で保存されるため、正規化した写しで引く (→ ADR-0086)。
const remoteActorToAccount = async (username: string, lookupDomain: string) => {
	const snapshot = await Objects.where('_meta.preferredUsername', '==', username).get();
	const actor = snapshot.docs
		.map((doc) => doc.data())
		.find(
			(object) =>
				isAPActor(object) &&
				object.id !== undefined &&
				new URL(object.id).host.toLowerCase() === lookupDomain.toLowerCase(),
		);
	if (actor === undefined) {
		return undefined;
	}
	assertIsAPActor(actor);
	await requestRemoteActorRefreshIfStale(actor);
	return actorObjectToAccount(actor);
};

export const getAccount = (acct: string) => {
	const [username, lookupDomain = domain] = acct.split('@');

	if (username === undefined) {
		return undefined;
	}

	if (lookupDomain !== domain) {
		return remoteActorToAccount(username, lookupDomain);
	}

	return actorUsernameToAccount(username);
};
