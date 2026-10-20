import assert from 'node:assert';
import { randomInt } from 'node:crypto';
import type { Timestamp } from '@google-cloud/firestore';
import type { APActor } from 'activitypub-types';
import firebase from 'firebase-admin';
import { uniq } from 'lodash-es';
import { db, escapeFirestoreKey, toFirestoreKey } from '../firebase.js';
import { buildMastodonId, isMastodonId, MAX_SEQUENCE } from '../mastodonId.js';
import { Lists } from '../schema.js';
import type { ListRecord, ListRepliesPolicy } from '../schema.js';
import { getFollowFlags } from './follows.js';

// リストは AP に対応物がないので、`userInfos/{actor}/lists/{リスト ID}` に直接保存する (→ ADR-0134)。

// Mastodon の `List::PER_ACCOUNT_LIMIT` / `TITLE_LENGTH_LIMIT` と同じ。
export const MAX_LISTS_PER_ACCOUNT = 50;
export const MAX_LIST_TITLE_LENGTH = 256;
export const LIST_REPLIES_POLICIES = ['followed', 'list', 'none'] as const;
export const DEFAULT_LIST_REPLIES_POLICY: ListRepliesPolicy = 'list';

export interface ListAttributes {
	title: string;
	repliesPolicy: ListRepliesPolicy;
	exclusive: boolean;
}

export type ListAccountsError = 'not_found' | 'not_following' | 'already_member';

const listsOf = (actorId: string) => Lists(escapeFirestoreKey(actorId));

// リスト ID はドキュメント ID なので、形式が違うもの (`/` を含むものなど) は引く前に弾く。
const listRef = (actorId: string, listId: string) =>
	isMastodonId(listId) ? listsOf(actorId).doc(toFirestoreKey(listId)) : undefined;

// 作成した順 (ID の昇順) に返す。
export const getLists = async (actorId: string): Promise<ListRecord[]> =>
	(await listsOf(actorId).orderBy('id', 'asc').get()).docs.map((doc) => doc.data());

export const getList = async (actorId: string, listId: string) =>
	(await listRef(actorId, listId)?.get())?.data();

// 上限 (MAX_LISTS_PER_ACCOUNT) に達していれば undefined。
export const createList = async (
	actorId: string,
	attributes: ListAttributes,
): Promise<ListRecord | undefined> => {
	const lists = listsOf(actorId);
	return await db.runTransaction(async (transaction) => {
		const count = (await transaction.get(lists.count())).data().count;
		if (count >= MAX_LISTS_PER_ACCOUNT) {
			return undefined;
		}
		const now = Date.now();
		const id = buildMastodonId(now, randomInt(MAX_SEQUENCE + 1));
		const list: ListRecord = {
			id,
			...attributes,
			accounts: [],
			createdAt: firebase.firestore.Timestamp.fromMillis(now) as unknown as Timestamp,
		};
		transaction.create(lists.doc(toFirestoreKey(id)), list);
		return list;
	});
};

// リストが無ければ undefined。
export const updateList = async (
	actorId: string,
	listId: string,
	attributes: Partial<ListAttributes>,
): Promise<ListRecord | undefined> => {
	const ref = listRef(actorId, listId);
	if (ref === undefined) {
		return undefined;
	}
	return await db.runTransaction(async (transaction) => {
		const current = (await transaction.get(ref)).data();
		if (current === undefined) {
			return undefined;
		}
		transaction.update(ref, attributes);
		return { ...current, ...attributes };
	});
};

// リストが無ければ false。
export const deleteList = async (actorId: string, listId: string): Promise<boolean> => {
	const ref = listRef(actorId, listId);
	if (ref === undefined || !(await ref.get()).exists) {
		return false;
	}
	await ref.delete();
	return true;
};

// Mastodon の `ListAccount#validate_relationship` と同じく、フォロー中・承認待ちの相手と自分だけを足せる。
// 1件でも足せなければ何も足さない (Mastodon はトランザクションで全件をまとめて足す)。
export const addListAccounts = async (
	owner: APActor,
	listId: string,
	accountIris: string[],
): Promise<{ ok: true } | { ok: false; error: ListAccountsError }> => {
	assert(owner.id !== undefined, 'owner.id is undefined');
	const ownerId = owner.id;
	const ref = listRef(ownerId, listId);
	if (ref === undefined) {
		return { ok: false, error: 'not_found' };
	}
	const iris = uniq(accountIris);
	const others = iris.filter((iri) => iri !== ownerId);
	const flags = await getFollowFlags(owner, others);
	if (flags.some((flag) => !flag.following && !flag.requested)) {
		return { ok: false, error: 'not_following' };
	}
	return db.runTransaction(async (transaction) => {
		const current = (await transaction.get(ref)).data();
		if (current === undefined) {
			return { ok: false, error: 'not_found' } as const;
		}
		if (iris.some((iri) => current.accounts.includes(iri))) {
			return { ok: false, error: 'already_member' } as const;
		}
		transaction.update(ref, { accounts: [...current.accounts, ...iris] });
		return { ok: true } as const;
	});
};

// メンバーでない相手は無視する。リストが無ければ false。
export const removeListAccounts = async (
	actorId: string,
	listId: string,
	accountIris: string[],
): Promise<boolean> => {
	const ref = listRef(actorId, listId);
	if (ref === undefined) {
		return false;
	}
	return await db.runTransaction(async (transaction) => {
		const current = (await transaction.get(ref)).data();
		if (current === undefined) {
			return false;
		}
		const removed = new Set(accountIris);
		transaction.update(ref, {
			accounts: current.accounts.filter((iri) => !removed.has(iri)),
		});
		return true;
	});
};

// `accountIri` をメンバーに含む、actor のリスト (`GET /api/v1/accounts/:id/lists`)。
export const getListsContaining = async (
	actorId: string,
	accountIri: string,
): Promise<ListRecord[]> =>
	(await listsOf(actorId).where('accounts', 'array-contains', accountIri).get()).docs
		.map((doc) => doc.data())
		.sort((a, b) => a.id.localeCompare(b.id));

// `exclusive` なリストのメンバー。ホームタイムラインから外す (→ ADR-0134 決定5)。
export const getExclusiveListMembers = async (actorId: string): Promise<Set<string>> =>
	new Set(
		(await listsOf(actorId).where('exclusive', '==', true).get()).docs.flatMap(
			(doc) => doc.data().accounts,
		),
	);
