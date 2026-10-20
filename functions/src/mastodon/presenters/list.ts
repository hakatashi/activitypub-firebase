import type { mastodon } from 'masto';
import type { ListRecord } from '../../schema.js';
import type { CamelToSnake } from '../../utils.js';
import { MASTODON_ID_LENGTH } from '../../mastodonId.js';
import { resolveAccountIds, userIdsToAccountsMap } from './account.js';

export interface ListEntity {
	id: string;
	title: string;
	replies_policy: ListRecord['repliesPolicy'];
	exclusive: boolean;
}

export const listToEntity = (list: ListRecord): ListEntity => ({
	id: list.id,
	title: list.title,
	replies_policy: list.repliesPolicy,
	exclusive: list.exclusive,
});

export const LIST_ACCOUNTS_PAGE_LIMITS = { defaultLimit: 40, maxLimit: 80 };

// メンバー一覧のページ。`limit` が undefined なら全件 (Mastodon の `limit=0`)。
export interface ListAccountsPageParams {
	limit?: number | undefined;
	maxId?: string | undefined;
	sinceId?: string | undefined;
}

// ローカルのアカウント ID (`1` など) とリモートの Mastodon ID (20 桁) を同じ大小で比べられるよう、桁数をそろえる。
const toSortKey = (accountId: string) => accountId.padStart(MASTODON_ID_LENGTH, '0');

// Mastodon と同じくアカウント ID の降順に並べ、アカウント ID をカーソルにする (→ ADR-0134 決定6)。
// 返す `cursorIds` は `accounts` と同じ並び。
export const getListAccountsPage = async (
	list: ListRecord,
	page: ListAccountsPageParams,
): Promise<{ accounts: CamelToSnake<mastodon.v1.Account>[]; cursorIds: string[] }> => {
	const accountIds = await resolveAccountIds(list.accounts);
	const maxKey = page.maxId === undefined ? undefined : toSortKey(page.maxId);
	const sinceKey = page.sinceId === undefined ? undefined : toSortKey(page.sinceId);
	const entries = list.accounts
		.flatMap((iri) => {
			const accountId = accountIds.get(iri);
			return accountId === undefined ? [] : [{ iri, accountId, key: toSortKey(accountId) }];
		})
		.filter(
			({ key }) =>
				(maxKey === undefined || key < maxKey) && (sinceKey === undefined || key > sinceKey),
		)
		.sort((a, b) => b.key.localeCompare(a.key))
		.slice(0, page.limit);
	const accountsMap = await userIdsToAccountsMap(
		entries.map((entry) => entry.iri),
		accountIds,
	);
	const validEntries = entries.filter((entry) => accountsMap.has(entry.iri));
	return {
		accounts: validEntries.map((entry) => accountsMap.get(entry.iri)!),
		cursorIds: validEntries.map((entry) => entry.accountId),
	};
};
