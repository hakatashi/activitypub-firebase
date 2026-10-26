import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';

// Mastodon 本家の `/share?text=` に相当するリダイレクト (→ ADR-0165)。
describe('GET /share', () => {
	test('redirects to the Elk intent page with text', async () => {
		const res = await request(mastodon).get('/share').query({ text: 'Hello 世界 #tag&more=1' });
		expect(res.status).toBe(302);
		const location = new URL(String(res.headers.location));
		expect(`${location.origin}${location.pathname}`).toBe('https://elk.zone/intent/post');
		expect(location.searchParams.get('text')).toBe('Hello 世界 #tag&more=1');
		expect([...location.searchParams.keys()]).toEqual(['text']);
	});

	test('redirects without a query when text is missing', async () => {
		const res = await request(mastodon).get('/share').query({ other: 'x' });
		expect(res.status).toBe(302);
		expect(res.headers.location).toBe('https://elk.zone/intent/post');
	});
});
