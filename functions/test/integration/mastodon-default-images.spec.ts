import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 画像のない Account の `avatar` / `header` に返す既定画像 (→ ADR-0109)。
describe('default avatar and header images (Issue #252)', () => {
	test.each(['/avatars/original/missing.png', '/headers/original/missing.png'])(
		'serves a PNG at %s',
		async (path) => {
			const res = await request(mastodon)
				.get(path)
				.buffer(true)
				.parse((response, callback) => {
					const chunks: Buffer[] = [];
					response.on('data', (chunk: Buffer) => chunks.push(chunk));
					response.on('end', () => callback(null, Buffer.concat(chunks)));
				});
			expect(res.status).toBe(200);
			expect(res.headers['content-type']).toBe('image/png');
			expect(res.headers['cache-control']).toBe('public, max-age=86400, s-maxage=86400');
			expect((res.body as Buffer).subarray(0, 8)).toEqual(PNG_SIGNATURE);
		},
	);
});
