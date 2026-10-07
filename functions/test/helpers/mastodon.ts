import request from 'supertest';
import { mastodonApi, mediaUploadApi } from '../../src/mastodon/index.js';

export type HttpMethod = 'get' | 'post' | 'delete' | 'patch' | 'put';

/**
 * Authorization ヘッダ付きの Mastodon API リクエストを発行する supertest ラッパー。
 * /api/v1/media や /api/v2/media は Hosting rewrites と同様に mediaUploadApi へルーティングする (→ ADR-0094)。
 */
export const mastodonRequest = (method: HttpMethod, path: string, token?: string): request.Test => {
	const target =
		path.startsWith('/api/v1/media') || path.startsWith('/api/v2/media')
			? mediaUploadApi
			: mastodonApi;
	const req = request(target)[method](path);
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
