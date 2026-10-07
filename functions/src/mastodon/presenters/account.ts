import assert from 'node:assert';
import type { APObject as ApexObject, JsonLdActor } from '../../apex/index.js';
import type { APActor } from 'activitypub-types';
import firebase from 'firebase-admin';
import { chunk, last, uniq } from 'lodash-es';
import type { mastodon } from 'masto';
import { apex } from '../../apex.js';
import {
	getFollowFlags,
	getFollowersPageEntries,
	getFollowingPageEntries,
} from '../../social/follows.js';
import {
	domain,
	escapeFirestoreKey,
	mastodonDomain,
	toFirestoreKey,
	unescapeFirestoreKey,
} from '../../firebase.js';
import { getIriByMastodonId, getMastodonIds, getOrAssignMastodonId } from '../../mastodonId.js';
import { htmlToPlainText } from '../../notes.js';
import { Objects, UserInfo, UserInfos } from '../../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../../store/limits.js';
import type { CamelToSnake } from '../../utils.js';
import { isAPActor } from '../../utils.js';
import type { PageParams } from '../pagination.js';
import { getObjects } from '../../store/objects.js';

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

export const actorObjectToAccount = async (
	actorObject: APActor,
	userInfo?: UserInfo,
	id?: string,
): Promise<CamelToSnake<mastodon.v1.Account>> => {
	// activitypub-types の APActor は icon/image を IconField|ImageField の union として定義するなど
	// ここでの緩いプロパティアクセスと厳密には一致しない。この不整合の解消は ADR-0022 の対象外
	// (apex 自体の型付けのみが対象) なので、ここでは toJSONLD 呼び出し以前と同じ緩さを維持する。
	const actor = await apex.toJSONLD<JsonLdActor>(actorObject);
	const username = actor.preferredUsername ?? last(actor.id.split('/')) ?? '';
	const actorDomain = new URL(actor.id).host;
	const isLocal = actorDomain === domain;

	const baseUserInfo = userInfo ?? externalUserInfo;
	// ローカルは Elk のプロフィールへ誘導する (→ ADR-0004)。リモートは相手サーバーのプロフィール URL。
	let url = actor.id;
	if (isLocal) {
		url = `https://elk.zone/${mastodonDomain}/@${username}@${domain}`;
	} else if (typeof actor.url === 'string') {
		url = actor.url;
	}
	const accountId =
		id ?? userInfo?.id ?? (await getOrAssignMastodonId(actor.id, actorObject.published));

	return {
		...baseUserInfo,
		id: accountId,
		username,
		acct: isLocal ? username : `${username}@${actorDomain}`,
		display_name: actor.name ?? '',
		url,
		avatar: actor.icon?.url ?? '',
		avatar_static: actor.icon?.url ?? '',
		header: actor.image?.url ?? '',
		header_static: actor.image?.url ?? '',
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

export const accountToCredentialAccount = (
	account: CamelToSnake<mastodon.v1.Account>,
	userInfo: UserInfo,
): CredentialAccountEntity => ({
	...account,
	source: {
		privacy: 'public',
		sensitive: false,
		language: 'ja',
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

export const userIdsToAccounts = async (
	userIds: string[],
	knownAccountIds?: Map<string, string>,
): Promise<CamelToSnake<mastodon.v1.Account>[]> => {
	if (userIds.length === 0) {
		return [];
	}

	const [actorObjects, userInfoDocsChunks, accountIds] = await Promise.all([
		getObjects(userIds),
		Promise.all(
			chunk(userIds.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT).map((idChunk) =>
				UserInfos.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
			),
		),
		knownAccountIds ?? resolveAccountIds(userIds),
	]);

	const actorMap = new Map<string, APActor>(
		actorObjects.map((actor) => {
			assertIsAPActor(actor);
			return [actor.id, actor];
		}),
	);
	const userInfoMap = new Map<string, UserInfo>(
		userInfoDocsChunks.flatMap((userInfos) =>
			userInfos.docs.map(
				(doc) => [unescapeFirestoreKey(toFirestoreKey(doc.id)), doc.data()] as const,
			),
		),
	);

	return Promise.all(
		userIds.map((userId) => {
			const actor = actorMap.get(userId);
			assert(actor !== undefined, 'actor is undefined');

			const userInfo = userInfoMap.get(userId);
			const accountId = accountIds.get(userId);

			return actorObjectToAccount(actor, userInfo, accountId);
		}),
	);
};

export const FOLLOWERS_PAGE_LIMITS = { defaultLimit: 40, maxLimit: 80 };

// カーソルは Follow アクティビティの Mastodon ID (Mastodon の follow 行 ID に相当。→ ADR-0062)。
// 返す `cursorIds` は `accounts` と同じ並び (新しい順)。
export const getFollowersPage = async (
	actor: APActor,
	page: PageParams = { limit: FOLLOWERS_PAGE_LIMITS.defaultLimit },
) => {
	const pageEntries = await getFollowersPageEntries(actor, page);
	return {
		accounts: await userIdsToAccounts(pageEntries.map((entry) => entry.actorIri)),
		cursorIds: pageEntries.map((entry) => entry.cursorId),
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
	return {
		accounts: await userIdsToAccounts(pageEntries.map((entry) => entry.actorIri)),
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
		const object = await apex.store.getObject(iri);
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
