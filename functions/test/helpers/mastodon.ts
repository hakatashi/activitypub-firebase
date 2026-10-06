import request from 'supertest';
import { mastodonApi } from '../../src/mastodon/index.js';

export type HttpMethod = 'get' | 'post' | 'delete' | 'patch' | 'put';

/**
 * Authorization ヘッダ付きの Mastodon API リクエストを発行する supertest ラッパー。
 */
export const mastodonRequest = (method: HttpMethod, path: string, token?: string): request.Test => {
	const req = request(mastodonApi)[method](path);
	if (token !== undefined) {
		req.set('Authorization', `Bearer ${token}`);
	}
	return req;
};

export const mastodon = {
	get: (path: string, token?: string) => mastodonRequest('get', path, token),
	post: (path: string, token?: string) => mastodonRequest('post', path, token),
	delete: (path: string, token?: string) => mastodonRequest('delete', path, token),
	patch: (path: string, token?: string) => mastodonRequest('patch', path, token),
	put: (path: string, token?: string) => mastodonRequest('put', path, token),
};
