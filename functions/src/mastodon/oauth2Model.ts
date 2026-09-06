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

export class Oauth2Model implements AuthorizationCodeModel, PasswordModel, ClientCredentialsModel {
	async getAccessToken(accessToken: string): Promise<Token | false> {
		const results = await AccessTokens.where('accessToken', '==', accessToken).get();
		const doc = results.docs[0];
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
		const results = await AuthorizationCodes.where(
			'authorizationCode',
			'==',
			authorizationCode,
		).get();
		const doc = results.docs[0];
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

		const results = await query.get();
		const doc = results.docs[0];
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

	async getUserFromClient(client: Client): Promise<User | false> {
		if (!client.userId) {
			return false;
		}
		const results = await Users.where('id', '==', client.userId).get();
		const doc = results.docs[0];
		if (!doc) {
			return false;
		}
		return doc.data();
	}

	async getUser(username: string, password: string): Promise<User | false> {
		const results = await Users.where('username', '==', username)
			.where('password', '==', password)
			.get();
		const doc = results.docs[0];
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
