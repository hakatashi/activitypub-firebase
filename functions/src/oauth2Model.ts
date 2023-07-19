import type {CollectionReference} from '@google-cloud/firestore';
import type {AuthorizationCodeModel, PasswordModel, ClientCredentialsModel, Token, AuthorizationCode, Client, User, RefreshToken} from '@node-oauth/oauth2-server';
import {db} from './firebase';

export interface MastodonClient extends Client {
	clientId: string,
	clientSecret: string,
	vapidKey: string,
	name: string,
	scopes: string[]
	userId?: string,
}

export const AccessTokens = db.collection('accessTokens') as CollectionReference<Token>;
export const RefreshTokens = db.collection('refreshTokens') as CollectionReference<RefreshToken>;
export const AuthorizationCodes = db.collection('authorizationCodes') as CollectionReference<AuthorizationCode>;
export const Clients = db.collection('clients') as CollectionReference<MastodonClient>;
export const Users = db.collection('users') as CollectionReference<User & {username: string, password: string}>;

export class Oauth2Model implements AuthorizationCodeModel, PasswordModel, ClientCredentialsModel {
	async getAccessToken(accessToken: string): Promise<Token | false> {
		const results = await AccessTokens.where('accessToken', '==', accessToken).get();
		if (results.empty) {
			return false;
		}
		return results.docs[0].data();
	}

	async getAuthorizationCode(authorizationCode: string): Promise<AuthorizationCode | false> {
		const results = await AuthorizationCodes.where('authorizationCode', '==', authorizationCode).get();
		if (results.empty) {
			return false;
		}
		return results.docs[0].data();
	}

	async saveAuthorizationCode(
		code: Pick<AuthorizationCode, 'authorizationCode' | 'expiresAt' | 'redirectUri' | 'scope' | 'codeChallenge' | 'codeChallengeMethod'>,
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
			if (results.empty) {
				return false;
			}
			transaction.delete(results.docs[0].ref);
			return true;
		});
	}

	async getClient(clientId: string, clientSecret: string | null): Promise<Client | false> {
		let query = Clients
			.where('clientId', '==', clientId);
		if (clientSecret !== null) {
			query = query.where('clientSecret', '==', clientSecret);
		}

		const results = await query.get();
		if (results.empty) {
			return false;
		}

		return results.docs[0].data();
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
				refreshTokenExpiresAt: token.refreshTokenExpiresAt,
				client,
				user,
				scope: token.scope,
			} as RefreshToken;
			await RefreshTokens.add(refreshToken);
		}

		return accessToken;
	}

	async getUserFromClient(client: Client): Promise<User | false> {
		const results = await Users.where('id', '==', client.userId).get();
		if (results.empty) {
			return false;
		}
		return results.docs[0].data();
	}

	async getUser(username: string, password: string): Promise<User | false> {
		const results = await Users
			.where('username', '==', username)
			.where('password', '==', password)
			.get();
		if (results.empty) {
			return false;
		}
		return results.docs[0].data();
	}

	verifyScope(token: Token, scope: string | string[]): Promise<boolean> {
		if (!token.scope) {
			return Promise.resolve(false);
		}

		const requestedScopes = new Set(Array.isArray(scope) ? scope : scope.split(' '));
		const authorizedScopes = new Set(Array.isArray(token.scope) ? token.scope : token.scope.split(' '));

		for (const requestedScope of requestedScopes) {
			if (!authorizedScopes.has(requestedScope)) {
				return Promise.resolve(false);
			}
		}

		return Promise.resolve(true);
	}
}
