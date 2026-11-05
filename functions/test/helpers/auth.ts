import { Timestamp } from 'firebase-admin/firestore';
import { AccessTokens } from '../../src/schema.js';

export interface AddAccessTokenOptions {
	uid?: string;
	clientId?: string;
	expiresInMs?: number;
}

/**
 * テスト用のアクセストークンを AccessTokens コレクションに投入する。
 */
export const addAccessToken = async (
	token: string,
	scope: string,
	uidOrOptions: string | AddAccessTokenOptions = 'uid-hakatashi',
): Promise<void> => {
	const options: AddAccessTokenOptions =
		typeof uidOrOptions === 'string' ? { uid: uidOrOptions } : uidOrOptions;
	const uid = options.uid ?? 'uid-hakatashi';
	const expiresInMs = options.expiresInMs ?? 60 * 60 * 1000;
	const farFuture = Timestamp.fromMillis(Date.now() + expiresInMs);
	await AccessTokens.add({
		accessToken: token,
		accessTokenExpiresAt: farFuture,
		refreshTokenExpiresAt: farFuture,
		scope,
		client: { id: options.clientId ?? '1', grants: [] },
		user: { userId: uid },
	} as never);
};
