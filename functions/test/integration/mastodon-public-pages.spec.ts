import type { APObject } from '../../src/apex/index.js';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { domain, mastodonDomain } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getMastodonIds } from '../../src/mastodonId.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';

const REMOTE = 'https://remote.example/users/alice';
const UID = 'uid-hakatashi';

// リンクプレビュー用の最小限の HTML (→ ADR-0107)。
describe('public HTML pages for link previews (Issue #163)', () => {
	const post = (body: Record<string, unknown>) =>
		request(mastodon).post('/api/v1/statuses').set('Authorization', 'Bearer token').send(body);

	beforeEach(async () => {
		await resetFirestore();
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);
		await createLocalActor('hakatashi', {
			uid: UID,
			id: '1',
			displayName: 'Hakatashi',
			summary: '<p>bio</p>',
			icon: 'https://img.example/avatar.png',
		});
		await addAccessToken('token', 'read write', UID);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	const ogDescription = (html: string) =>
		html.match(/<meta property="og:description" content="(?<content>[^"]*)" \/>/)?.groups?.content;

	test.each(['hakatashi', `hakatashi@${domain}`, 'HakataShi'])(
		'returns an OGP page for a public status at /@%s/:id',
		async (acct) => {
			const created = await post({ status: 'hello <world>' });
			expect(created.status).toBe(200);
			expect(created.body.url).toBe(`https://${mastodonDomain}/@hakatashi/${created.body.id}`);

			const res = await request(mastodon)
				.get(`/@${acct}/${created.body.id}`)
				.set('User-Agent', 'Discordbot/2.0');
			expect(res.status).toBe(200);
			expect(res.headers['content-type']).toMatch(/^text\/html/);
			expect(res.headers['content-security-policy']).toContain("default-src 'none'");
			expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=300');
			expect(ogDescription(res.text)).toBe('hello &lt;world&gt;');
			expect(res.text).toContain('<meta property="og:title" content="Hakatashi (@hakatashi@');
			expect(res.text).toContain(
				'<meta property="og:image" content="https://img.example/avatar.png" />',
			);
			expect(res.text).toContain(
				`<link rel="alternate" type="application/activity+json" href="${created.body.uri}" />`,
			);
			expect(res.text).toContain(
				`href="https://elk.zone/${mastodonDomain}/@hakatashi@${domain}/${created.body.id}"`,
			);
		},
	);

	test('returns an unlisted status and uses the CW as the description', async () => {
		const created = await post({ status: 'body', spoiler_text: 'cw', visibility: 'unlisted' });
		const res = await request(mastodon).get(`/@hakatashi/${created.body.id}`);
		expect(res.status).toBe(200);
		expect(ogDescription(res.text)).toBe('cw');
	});

	test.each(['private', 'direct'])('hides %s statuses as 404', async (visibility) => {
		const created = await post({ status: 'secret', visibility });
		const res = await request(mastodon).get(`/@hakatashi/${created.body.id}`);
		expect(res.status).toBe(404);
		expect(res.headers['cache-control']).toBe('no-store');
		expect(res.text).not.toContain('secret');
	});

	test('returns 404 for deleted, unknown, malformed IDs and other accounts', async () => {
		const created = await post({ status: 'gone' });
		expect((await request(mastodon).get(`/@alice/${created.body.id}`)).status).toBe(404);
		expect(
			(await request(mastodon).get(`/@hakatashi@remote.example/${created.body.id}`)).status,
		).toBe(404);
		expect((await request(mastodon).get('/@hakatashi/00000000000000000001')).status).toBe(404);
		expect((await request(mastodon).get('/@hakatashi/abc')).status).toBe(404);

		await request(mastodon)
			.delete(`/api/v1/statuses/${created.body.id}`)
			.set('Authorization', 'Bearer token');
		expect((await request(mastodon).get(`/@hakatashi/${created.body.id}`)).status).toBe(404);
	});

	test("returns 404 for a remote actor's public note", async () => {
		await apex.store.saveObject({
			id: REMOTE,
			type: 'Person',
			preferredUsername: 'alice',
			inbox: `${REMOTE}/inbox`,
			outbox: `${REMOTE}/outbox`,
		} as unknown as APObject);
		const iri = `${REMOTE}/statuses/1`;
		await apex.store.saveObject({
			id: iri,
			type: 'Note',
			attributedTo: REMOTE,
			content: 'remote',
			published: '2026-01-01T00:00:00.000Z',
			to: ['https://www.w3.org/ns/activitystreams#Public'],
		} as unknown as APObject);
		const id = (await getMastodonIds([{ iri, published: undefined }])).get(iri);
		expect((await request(mastodon).get(`/@hakatashi/${id}`)).status).toBe(404);
	});

	test('returns the profile page', async () => {
		const res = await request(mastodon).get(`/@hakatashi@${domain}`);
		expect(res.status).toBe(200);
		expect(res.text).toContain('<meta property="og:type" content="profile" />');
		expect(ogDescription(res.text)).toBe('bio');
		expect((await request(mastodon).get('/@alice')).status).toBe(404);
	});
});
