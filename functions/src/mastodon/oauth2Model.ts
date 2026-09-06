import type {
	AuthorizationCodeModel,
	PasswordModel,
	ClientCredentialsModel,
	Token,
	AuthorizationCode,
	Client,
	User,
	RefreshToken,
} from '@node-oauth/oauth2-server';
import { db } from '../firebase.js';
import { AccessTokens, AuthorizationCodes, Clients, RefreshTokens, Users } from '../schema.js';

export type { MastodonClient } from '../schema.js';

// クエリを実行し、最初の1件(なければ undefined)を返す。
// 各メソッドがそれぞれ独自に `results.docs[0]` を取り出して乖離するのを避ける。
const getFirstDoc = async <T extends FirebaseFirestore.DocumentData>(
	query: FirebaseFirestore.Query<T>,
): Promise<FirebaseFirestore.QueryDocumentSnapshot<T> | undefined> => {
	const results = await query.get();
	return results.docs[0];
};

export class Oauth2Model implements AuthorizationCodeModel, PasswordModel, ClientCredentialsModel {
	async getAccessToken(accessToken: string): Promise<Token | false> {
		const doc = await getFirstDoc(AccessTokens.where('accessToken', '==', accessToken));
		if (!doc) {
			return false;
		}
		const accessTokenData = doc.data();
		return {
			...accessTokenData,
			// @ts-expect-error: Return type is different from the interface
			accessTokenExpiresAt: accessTokenData.accessTokenExpiresAt.toDate(),
			// @ts-expect-error: Return type is different from the interface
			refreshTokenExpiresAt: accessTokenData.refreshTokenExpiresAt.toDate(),
		};
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
			// @ts-expect-error: Return type is different from the interface
			expiresAt: authorizationCodeData.expiresAt.toDate(),
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
		const authorizationCode = {
			...code,
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

	async getClient(clientId: string, clientSecret: string | null): Promise<Client | false> {
		let query = Clients.where('clientId', '==', clientId);
		if (clientSecret !== null) {
			query = query.where('clientSecret', '==', clientSecret);
		}

		const doc = await getFirstDoc(query);
		if (!doc) {
			return false;
		}

		return doc.data();
	}

	async saveToken(token: Token, client: Client, user: User): Promise<Token | false> {
		const accessToken = {
			...token,
			client,
			user,
		};
		await AccessTokens.add(accessToken);

		if (token.refreshToken !== undefined) {
			const refreshToken = {
				refreshToken: token.refreshToken,
				...(token.refreshTokenExpiresAt === undefined
					? {}
					: { refreshTokenExpiresAt: token.refreshTokenExpiresAt }),
				client,
				user,
				...(token.scope === undefined ? {} : { scope: token.scope }),
			} satisfies RefreshToken;
			await RefreshTokens.add(refreshToken);
		}

		return accessToken;
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

	async getUser(username: string, password: string): Promise<User | false> {
		const doc = await getFirstDoc(
			Users.where('username', '==', username).where('password', '==', password),
		);
		if (!doc) {
			return false;
		}
		return doc.data();
	}

	verifyScope(token: Token, scope: string | string[]): Promise<boolean> {
		if (!token.scope) {
			return Promise.resolve(false);
		}

		const requestedScopes = new Set(Array.isArray(scope) ? scope : scope.split(' '));
		const authorizedScopes = new Set(
			Array.isArray(token.scope) ? token.scope : token.scope.split(' '),
		);

		for (const requestedScope of requestedScopes) {
			if (!authorizedScopes.has(requestedScope)) {
				return Promise.resolve(false);
			}
		}

		return Promise.resolve(true);
	}
}
