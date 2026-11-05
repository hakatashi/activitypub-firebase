import express from 'express';
import type { AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import { mastodonCors } from '../../src/mastodon/http/middlewares.js';

describe('mastodonCors', () => {
	test('preflight lets browsers cache the result for 2 hours', async () => {
		const app = express();
		app.use('/api', mastodonCors);
		const server = app.listen(0);
		try {
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const res = await fetch(`${base}/api/v1/timelines/home`, {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://phanpy.social',
					'Access-Control-Request-Method': 'GET',
					'Access-Control-Request-Headers': 'authorization',
				},
			});
			expect(res.status).toBe(204);
			expect(res.headers.get('access-control-allow-origin')).toBe('https://phanpy.social');
			expect(res.headers.get('access-control-max-age')).toBe('7200');
		} finally {
			server.close();
		}
	});
});
