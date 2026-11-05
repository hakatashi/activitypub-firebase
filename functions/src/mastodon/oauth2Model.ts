import type {
	AuthorizationCodeModel,
	PasswordModel,
	ClientCredentialsModel,
	RefreshTokenModel,
	Token,
	AuthorizationCode,
	Client,
	User,
	RefreshToken,
} from '@node-oauth/oauth2-server';
import { createHash } from 'node:crypto';
import { db } from '../firebase.js';
import { AccessTokens, AuthorizationCodes, Clients, RefreshTokens, Users } from '../schema.js';
import { clonePlain, createTtlCache } from './http/instanceCache.js';

export type { MastodonClient } from '../schema.js';

// アクセストークンは本家 Mastodon と同様に無期限として扱う(ADR-0133)。
// oauth2-server の Token が accessTokenExpiresAt を要求するため、無期限はこの日付で表す。
// 実データにも同じ値を保存する。
export const ACCESS_TOKEN_NEVER_EXPIRES_AT = new Date('9999-12-31T00:00:00.000Z');

// アクセストークン → uid・スコープ・有効期限・クライアント ID のインスタンス内キャッシュ (→ ADR-0169)。
// キーはトークンのハッシュで、トークンそのものはキーにも値にも持たない。
type CachedAccessToken = Pick<Token, 'user' | 'scope' | 'accessTokenExpiresAt'> & {
	client: Pick<Client, 'id' | 'grants'>;
};

const accessTokenCache = createTtlCache<CachedAccessToken>({
	maxEntries: 64,
	maxAgeMs: 5 * 60 * 1000,
});

const hashAccessToken = (accessToken: string) =>
	createHash('sha256').update(accessToken).digest('hex');

export const clearAccessTokenCache = () => {
	accessTokenCache.clear();
};

const toDate = (timestamp: unknown): Date | undefined => {
	if (timestamp instanceof Date) {
		return timestamp;
	}
	if (
		typeof timestamp === 'object' &&
		timestamp !== null &&
		'toDate' in timestamp &&
		typeof (timestamp as { toDate: () => unknown }).toDate === 'function'
	) {
		const date = (timestamp as { toDate: () => unknown }).toDate();
		if (date instanceof Date) {
			return date;
		}
	}
	return undefined;
};

// クエリを実行し、最初の1件(なければ undefined)を返す。
// 各メソッドがそれぞれ独自に `results.docs[0]` を取り出して乖離するのを避ける。
export const getFirstDoc = async <T extends FirebaseFirestore.DocumentData>(
	query: FirebaseFirestore.Query<T>,
): Promise<FirebaseFirestore.QueryDocumentSnapshot<T> | undefined> => {
	const results = await query.limit(1).get();
	return results.docs[0];
};

export class Oauth2Model
	implements AuthorizationCodeModel, PasswordModel, ClientCredentialsModel, RefreshTokenModel
{
	async getAccessToken(accessToken: string): Promise<Token | false> {
		const cacheKey = hashAccessToken(accessToken);
		const cached = accessTokenCache.get(cacheKey);
		if (cached !== undefined) {
			return { ...clonePlain(cached), accessToken };
		}

		const doc = await getFirstDoc(AccessTokens.where('accessToken', '==', accessToken));
		if (!doc) {
			return false;
		}
		const accessTokenData = doc.data();
		const { refreshTokenExpiresAt: rawRefreshTokenExpiresAt, ...rest } = accessTokenData;
		const refreshTokenExpiresAt = toDate(rawRefreshTokenExpiresAt);
		const token: Token = {
			...rest,
			user: accessTokenData.user ?? {},
			accessTokenExpiresAt:
				toDate(accessTokenData.accessTokenExpiresAt) ?? ACCESS_TOKEN_NEVER_EXPIRES_AT,
			client: accessTokenData.client,
			...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
		};
		accessTokenCache.set(
			cacheKey,
			clonePlain({
				user: token.user,
				...(token.scope === undefined ? {} : { scope: token.scope }),
				...(token.accessTokenExpiresAt === undefined
					? {}
					: { accessTokenExpiresAt: token.accessTokenExpiresAt }),
				client: { id: token.client.id, grants: token.client.grants },
			}),
		);
		return token;
	}

	async getAuthorizationCode(authorizationCode: string): Promise<AuthorizationCode | false> {
		const doc = await getFirstDoc(
			AuthorizationCodes.where('authorizationCode', '==', authorizationCode),
		);
		if (!doc) {
			return false;
		}
		const authorizationCodeData = doc.data();
		return {
			...authorizationCodeData,
			expiresAt: toDate(authorizationCodeData.expiresAt) ?? new Date(0),
		};
	}

	async saveAuthorizationCode(
		code: Pick<
			AuthorizationCode,
			| 'authorizationCode'
			| 'expiresAt'
			| 'redirectUri'
			| 'scope'
			| 'codeChallenge'
			| 'codeChallengeMethod'
		>,
		client: Client,
		user: User,
	): Promise<AuthorizationCode | false> {
		const authorizationCode: AuthorizationCode = {
			authorizationCode: code.authorizationCode,
			expiresAt: code.expiresAt,
			redirectUri: code.redirectUri,
			...(code.scope === undefined ? {} : { scope: code.scope }),
			...(code.codeChallenge === undefined ? {} : { codeChallenge: code.codeChallenge }),
			...(code.codeChallengeMethod === undefined
				? {}
				: { codeChallengeMethod: code.codeChallengeMethod }),
			client,
			user,
		};
		await AuthorizationCodes.add(authorizationCode);
		return authorizationCode;
	}

	revokeAuthorizationCode(code: AuthorizationCode): Promise<boolean> {
		return db.runTransaction(async (transaction) => {
			const results = await transaction.get(
				AuthorizationCodes.where('authorizationCode', '==', code.authorizationCode),
			);
			const doc = results.docs[0];
			if (!doc) {
				return false;
			}
			transaction.delete(doc.ref);
			return true;
		});
	}

	async getClient(clientId: string, clientSecret?: string | null): Promise<Client | false> {
		let query = Clients.where('clientId', '==', clientId);
		if (clientSecret !== undefined && clientSecret !== null) {
			query = query.where('clientSecret', '==', clientSecret);
		}

		const doc = await getFirstDoc(query);
		if (!doc) {
			return false;
		}

		const clientData = doc.data();
		let redirectUris: string[] = [];
		if (Array.isArray(clientData.redirectUris)) {
			redirectUris = clientData.redirectUris;
		} else if (typeof clientData.redirectUris === 'string' && clientData.redirectUris.length > 0) {
			redirectUris = [clientData.redirectUris];
		}

		return {
			...clientData,
			redirectUris,
		};
	}

	async saveToken(
		token: Omit<Token, 'client' | 'user'>,
		client: Client,
		user: User,
	): Promise<Token | false> {
		const accessToken: Token = {
			...token,
			accessToken: token.accessToken,
			accessTokenExpiresAt: ACCESS_TOKEN_NEVER_EXPIRES_AT,
			client,
			user,
		};
		await AccessTokens.add(accessToken);

		if (token.refreshToken !== undefined) {
			const refreshToken: RefreshToken = {
				refreshToken: token.refreshToken,
				...(token.refreshTokenExpiresAt === undefined
					? {}
					: { refreshTokenExpiresAt: token.refreshTokenExpiresAt }),
				client,
				user,
				...(token.scope === undefined ? {} : { scope: token.scope }),
			};
			await RefreshTokens.add(refreshToken);
		}

		return accessToken;
	}

	async getRefreshToken(refreshToken: string): Promise<RefreshToken | false> {
		const doc = await getFirstDoc(RefreshTokens.where('refreshToken', '==', refreshToken));
		if (!doc) {
			return false;
		}
		const refreshTokenData = doc.data();
		const { refreshTokenExpiresAt: rawRefreshTokenExpiresAt, ...rest } = refreshTokenData;
		const refreshTokenExpiresAt = toDate(rawRefreshTokenExpiresAt);
		return {
			...rest,
			client: refreshTokenData.client,
			user: refreshTokenData.user,
			...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
		};
	}

	async revokeToken(token: RefreshToken | Token): Promise<boolean> {
		// 同じインスタンスのキャッシュだけを消す。他のインスタンスでは TTL まで使える (→ ADR-0169)。
		const revokedAccessTokens: string[] = [];
		const revoked = await db.runTransaction(async (transaction) => {
			revokedAccessTokens.length = 0;
			const docsToDelete: FirebaseFirestore.DocumentReference[] = [];

			if ('refreshToken' in token && typeof token.refreshToken === 'string') {
				const refreshResults = await transaction.get(
					RefreshTokens.where('refreshToken', '==', token.refreshToken),
				);
				for (const doc of refreshResults.docs) {
					docsToDelete.push(doc.ref);
				}

				const accessResultsWithRefresh = await transaction.get(
					AccessTokens.where('refreshToken', '==', token.refreshToken),
				);
				for (const doc of accessResultsWithRefresh.docs) {
					docsToDelete.push(doc.ref);
					revokedAccessTokens.push(doc.data().accessToken);
				}
			}

			if ('accessToken' in token && typeof token.accessToken === 'string') {
				const accessResults = await transaction.get(
					AccessTokens.where('accessToken', '==', token.accessToken),
				);
				for (const doc of accessResults.docs) {
					docsToDelete.push(doc.ref);
				}
				revokedAccessTokens.push(token.accessToken);
			}

			for (const ref of docsToDelete) {
				transaction.delete(ref);
			}

			return docsToDelete.length > 0;
		});
		for (const accessToken of revokedAccessTokens) {
			accessTokenCache.delete(hashAccessToken(accessToken));
		}
		return revoked;
	}

	async getUserFromClient(client: Client): Promise<User | false> {
		if (!client.userId) {
			return false;
		}
		const doc = await getFirstDoc(Users.where('id', '==', client.userId));
		if (!doc) {
			return false;
		}
		return doc.data();
	}

	async getUser(username: string, password: string, _client?: Client): Promise<User | false> {
		const doc = await getFirstDoc(
			Users.where('username', '==', username).where('password', '==', password),
		);
		if (!doc) {
			return false;
		}
		return doc.data();
	}

	verifyScope(token: Token, scope: string | string[]): Promise<boolean> {
		if (!token.scope || token.scope.length === 0) {
			return Promise.resolve(false);
		}

		const requestedScopes = new Set(Array.isArray(scope) ? scope : scope.split(' '));
		const authorizedScopes = new Set(
			Array.isArray(token.scope) ? token.scope : (token.scope as string).split(' '),
		);

		for (const requestedScope of requestedScopes) {
			if (!authorizedScopes.has(requestedScope)) {
				return Promise.resolve(false);
			}
		}

		return Promise.resolve(true);
	}
}
