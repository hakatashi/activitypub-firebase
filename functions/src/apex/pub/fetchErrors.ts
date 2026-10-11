import { isRecord } from '../values.js';

// リモート取得が、こちら側・第三者側の一時的な障害 (ネットワークエラー、タイムアウト、DNS 解決の失敗、
// 相手の 5xx / 408 / 429) で失敗したことを表す。同じリクエストでも再試行すれば成功しうるため、
// inbox はこれが原因の失敗に 4xx ではなく 5xx を返す (→ ADR-0115)。
export class TransientFetchError extends Error {}

export const isTransientStatus = (statusCode: number): boolean =>
	statusCode >= 500 || statusCode === 408 || statusCode === 429;

export const responseStatusError = (statusCode: number): Error => {
	const message = `Request failed with status code ${statusCode}`;
	return isTransientStatus(statusCode) ? new TransientFetchError(message) : new Error(message);
};

// 接続失敗やタイムアウトなど、応答を得る前の失敗は一時的な失敗として包む
export const withTransientFetchErrors = async <T>(url: URL, pending: Promise<T>): Promise<T> => {
	try {
		return await pending;
	} catch (err) {
		throw new TransientFetchError(`Failed to fetch ${url.toString()}`, { cause: err });
	}
};

const maxCauseDepth = 10;

// jsonld.js は documentLoader の例外を `details.cause` に、標準の Error は `cause` に包むため、
// その連鎖のどこかに TransientFetchError があるかを調べる
export const isTransientFailure = (err: unknown): boolean => {
	let current = err;
	for (let depth = 0; depth < maxCauseDepth && isRecord(current); depth++) {
		if (current instanceof TransientFetchError) {
			return true;
		}
		current = current.cause ?? (isRecord(current.details) ? current.details.cause : undefined);
	}
	return false;
};
