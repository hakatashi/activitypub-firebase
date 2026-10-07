import type { Transaction } from '@google-cloud/firestore';
import type { APObject } from '../apex/index.js';
import { prepareFollowProjectionUpdate } from './follows.js';
import { prepareNotificationProjectionUpdate } from './notifications.js';
import { prepareReactionProjectionUpdate } from './reactions.js';

// Store がアクティビティを書き換えるときに更新する射影をまとめる (→ ADR-0082, ADR-0084, ADR-0088)。
// Firestore のトランザクションは「すべての読み取りの後に書き込み」を要求するため、各射影の読み取りを
// 先に済ませ、書き込みは戻り値の関数でまとめて行う。戻り値の関数には、呼び出し側がこの後に採番した
// アクティビティの Mastodon ID を渡せる。どの射影にも関係しない書き換えなら undefined を返す。
export const prepareProjectionUpdates = async (
	transaction: Transaction,
	before: APObject | undefined,
	after: APObject | undefined,
): Promise<((mastodonId?: string) => void) | undefined> => {
	const commits = (
		await Promise.all([
			prepareFollowProjectionUpdate(transaction, before, after),
			prepareReactionProjectionUpdate(transaction, before, after),
			prepareNotificationProjectionUpdate(transaction, before, after),
		])
	).filter((commit) => commit !== undefined);
	if (commits.length === 0) {
		return undefined;
	}
	return (mastodonId) => {
		for (const commit of commits) {
			commit(mastodonId);
		}
	};
};
