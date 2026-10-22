import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { activitypub, app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import type { APObject, RemoteFetchPolicy } from '../../src/apex/index.js';
import { domain, escapeFirestoreKey, mastodonDomain, toFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { getOrAssignMastodonId } from '../../src/mastodonId.js';
import { ProjectionVersions } from '../../src/schema.js';
import {
	PREVIEW_HTML_MAX_BYTES,
	PREVIEW_IMAGE_MAX_BYTES,
	attachPreviewCard,
	decodeHtml,
	fetchPreviewCard,
	parsePreviewHtml,
	pickPreviewCardUrl,
	previewCardQueue,
	previewCardTaskId,
} from '../../src/social/previewCards.js';
import { previewCardTask } from '../../src/tasks.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const REMOTE = 'https://remote.example/users/alice';

const note = (content: string, extra: Record<string, unknown> = {}) =>
	({
		id: `${REMOTE}/statuses/1`,
		type: 'Note',
		attributedTo: REMOTE,
		content,
		published: '2026-10-01T00:00:00Z',
		to: [PUBLIC],
		...extra,
	}) as unknown as APObject;

const makeTaskRequest = (data: unknown) =>
	({ data }) as unknown as Parameters<typeof previewCardTask.run>[0];

describe('pickPreviewCardUrl', () => {
	test('picks the first plain link', () => {
		expect(
			pickPreviewCardUrl(
				note(
					'<p>see <a href="https://news.example/a?b=1" rel="nofollow">news</a> and <a href="https://other.example/">x</a></p>',
				),
			),
		).toBe('https://news.example/a?b=1');
	});

	test('skips mentions, hashtags, h-cards and links to this server', () => {
		const content = [
			'<span class="h-card"><a href="https://remote.example/@bob" class="u-url mention">@bob</a></span>',
			'<a href="https://misskey.example/@carol" class="mention">@carol</a>',
			'<a href="https://remote.example/tags/foo" class="mention hashtag" rel="tag">#foo</a>',
			'<a href="https://remote.example/tags/bar" rel="tag">#bar</a>',
			'<a href="https://remote.example/users/dave">@dave</a>',
			`<a href="https://${domain}/activitypub/u/hakatashi">me</a>`,
			`<a href="https://${mastodonDomain}/@hakatashi/1">mine</a>`,
			'<a href="mailto:a@example.com">mail</a>',
			'<a href="javascript:alert(1)">js</a>',
			'<a href="https://target.example/page">target</a>',
		].join(' ');
		expect(
			pickPreviewCardUrl(
				note(content, {
					tag: [{ type: 'Mention', href: 'https://remote.example/users/dave', name: '@dave' }],
				}),
			),
		).toBe('https://target.example/page');
	});

	test('returns undefined for notes with attachments, quotes or no links', () => {
		const content = '<p><a href="https://news.example/">news</a></p>';
		expect(
			pickPreviewCardUrl(note(content, { attachment: [{ type: 'Document', url: 'https://x/' }] })),
		).toBeUndefined();
		expect(pickPreviewCardUrl(note(content, { quoteUrl: 'https://x/1' }))).toBeUndefined();
		expect(pickPreviewCardUrl(note(content, { _misskey_quote: 'https://x/1' }))).toBeUndefined();
		expect(pickPreviewCardUrl(note('<p>no links</p>'))).toBeUndefined();
	});
});

describe('parsePreviewHtml', () => {
	const pageUrl = new URL('https://site.example/articles/1');

	test('prefers OGP and resolves a relative image', () => {
		const html = `<!doctype html><html><head>
			<title>Fallback</title>
			<meta property="og:title" content="  OG  title ">
			<meta name="description" content="meta description">
			<meta property="og:description" content="og description">
			<meta property="og:site_name" content="Site">
			<meta property="og:image" content="/images/a.png">
			<meta property="og:image:alt" content="alt text">
		</head><body></body></html>`;
		expect(parsePreviewHtml(html, pageUrl)).toEqual({
			title: 'OG title',
			description: 'og description',
			providerName: 'Site',
			image: { url: 'https://site.example/images/a.png', description: 'alt text' },
		});
	});

	test('falls back to <title> and the description meta', () => {
		const html =
			'<html><head><title>Plain &amp; simple</title><meta name="Description" content="desc"></head><body><svg><title>svg</title></svg></body></html>';
		expect(parsePreviewHtml(html, pageUrl)).toEqual({
			title: 'Plain & simple',
			description: 'desc',
			providerName: '',
			image: undefined,
		});
	});

	test('returns undefined without a title and ignores non-http images', () => {
		expect(parsePreviewHtml('<html><body><h1>x</h1></body></html>', pageUrl)).toBeUndefined();
		const html =
			'<html><head><title>t</title><meta property="og:image" content="javascript:alert(1)"></head></html>';
		expect(parsePreviewHtml(html, pageUrl)?.image).toBeUndefined();
	});
});

describe('decodeHtml', () => {
	// 「テスト」の Shift_JIS
	const sjis = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);

	test('uses the charset in Content-Type', () => {
		expect(decodeHtml(sjis, 'Shift_JIS')).toBe('テスト');
	});

	test('sniffs <meta charset> and falls back to UTF-8', () => {
		const html = Buffer.concat([Buffer.from('<meta charset="shift_jis"><title>'), sjis]);
		expect(decodeHtml(html, undefined)).toBe('<meta charset="shift_jis"><title>テスト');
		expect(decodeHtml(Buffer.from('<title>日本語</title>'), 'no-such-charset')).toBe(
			'<title>日本語</title>',
		);
	});
});

describe('fetching preview cards', () => {
	let server: Server;
	let origin: string;
	let requestedPaths: string[];
	let pngImage: Buffer;
	let originalPolicy: unknown;
	let enqueueSpy: MockInstance<typeof previewCardQueue.enqueue>;

	const html = (head: string) => `<!doctype html><html><head>${head}</head><body></body></html>`;

	const routes: Record<string, (res: ServerResponse) => void> = {
		'/article': (res) => {
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(
				html(
					'<meta property="og:title" content="Article"><meta property="og:description" content="About it"><meta property="og:site_name" content="Example"><meta property="og:image" content="/image.png">',
				),
			);
		},
		'/no-image': (res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(html('<title>No image</title>'));
		},
		'/redirect': (res) => {
			res.writeHead(301, { location: '/article' });
			res.end();
		},
		'/redirect-private': (res) => {
			res.writeHead(302, { location: 'http://10.0.0.1/secret' });
			res.end();
		},
		'/redirect-metadata': (res) => {
			res.writeHead(302, { location: 'http://169.254.169.254/computeMetadata/v1/' });
			res.end();
		},
		'/json': (res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end('{"title":"x"}');
		},
		'/huge': (res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.write(html('<title>Huge</title>'));
			res.end('x'.repeat(PREVIEW_HTML_MAX_BYTES * 2));
		},
		'/huge-image-page': (res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(html('<title>Huge image</title><meta property="og:image" content="/huge.png">'));
		},
		'/huge.png': (res) => {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(Buffer.alloc(PREVIEW_IMAGE_MAX_BYTES + 1));
		},
		'/svg-page': (res) => {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(html('<title>SVG</title><meta property="og:image" content="/image.svg">'));
		},
		'/image.svg': (res) => {
			res.writeHead(200, { 'content-type': 'image/svg+xml' });
			res.end('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"></svg>');
		},
		'/image.png': (res) => {
			res.writeHead(200, { 'content-type': 'image/png' });
			res.end(pngImage);
		},
	};

	const setPolicy = (policy: RemoteFetchPolicy) => {
		(apex.settings as { remoteFetchPolicy?: unknown }).remoteFetchPolicy = () => policy;
	};

	beforeAll(async () => {
		pngImage = await sharp({
			create: { width: 800, height: 420, channels: 3, background: '#3366cc' },
		})
			.png()
			.toBuffer();
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			const path = new URL(req.url ?? '/', 'http://localhost').pathname;
			requestedPaths.push(path);
			const route = routes[path];
			if (route === undefined) {
				res.writeHead(404);
				res.end();
				return;
			}
			route(res);
		});
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise((resolve) => {
			server.close(resolve);
		});
	});

	beforeEach(async () => {
		await resetFirestore();
		requestedPaths = [];
		originalPolicy = apex.settings.remoteFetchPolicy;
		enqueueSpy = vi.spyOn(previewCardQueue, 'enqueue').mockResolvedValue(undefined);
	});

	afterEach(async () => {
		(apex.settings as { remoteFetchPolicy?: unknown }).remoteFetchPolicy = originalPolicy;
		vi.restoreAllMocks();
		await resetFirestore();
	});

	describe('fetchPreviewCard', () => {
		test('builds a card with the image size and blurhash', async () => {
			const card = await fetchPreviewCard(`${origin}/article`);
			expect(card).toMatchObject({
				url: `${origin}/article`,
				title: 'Article',
				description: 'About it',
				providerName: 'Example',
				image: { url: `${origin}/image.png`, width: 800, height: 420, description: '' },
			});
			expect(card?.image?.blurhash).toEqual(expect.any(String));
		});

		test('follows redirects and keeps the original URL', async () => {
			const card = await fetchPreviewCard(`${origin}/redirect`);
			expect(card).toMatchObject({ url: `${origin}/redirect`, title: 'Article' });
			expect(requestedPaths).toEqual(['/redirect', '/article', '/image.png']);
		});

		test('returns null for non-HTML responses and errors', async () => {
			await expect(fetchPreviewCard(`${origin}/json`)).resolves.toBeNull();
			await expect(fetchPreviewCard(`${origin}/missing`)).resolves.toBeNull();
		});

		test('reads only the head of a huge page', async () => {
			await expect(fetchPreviewCard(`${origin}/huge`)).resolves.toMatchObject({ title: 'Huge' });
		});

		test('drops images that are too large or not raster images', async () => {
			await expect(fetchPreviewCard(`${origin}/huge-image-page`)).resolves.toMatchObject({
				title: 'Huge image',
				image: null,
			});
			await expect(fetchPreviewCard(`${origin}/svg-page`)).resolves.toMatchObject({
				title: 'SVG',
				image: null,
			});
		});
	});

	describe('SSRF protection', () => {
		test('does not connect to loopback addresses with the production policy', async () => {
			setPolicy({});
			await expect(fetchPreviewCard(`${origin}/article`)).resolves.toBeNull();
			expect(requestedPaths).toEqual([]);
		});

		test('rejects the metadata server, private addresses and non-http schemes', async () => {
			setPolicy({});
			for (const url of [
				'http://169.254.169.254/computeMetadata/v1/',
				'http://metadata.google.internal/',
				'http://10.0.0.1/',
				'http://[::1]/',
				'file:///etc/passwd',
				'ftp://ftp.example/',
			]) {
				await expect(fetchPreviewCard(url)).resolves.toBeNull();
			}
		});

		test('rejects hostnames that resolve to private addresses', async () => {
			setPolicy({ resolveAddresses: () => Promise.resolve(['192.168.0.10']) });
			await expect(fetchPreviewCard('https://rebind.example/')).resolves.toBeNull();
		});

		test('checks every redirect hop', async () => {
			// テスト用のポリシー (unicast とループバックを許す) でも、リダイレクト先の private・link-local は拒否する
			await expect(fetchPreviewCard(`${origin}/redirect-private`)).resolves.toBeNull();
			await expect(fetchPreviewCard(`${origin}/redirect-metadata`)).resolves.toBeNull();
			expect(requestedPaths).toEqual(['/redirect-private', '/redirect-metadata']);
		});
	});

	describe('previewCardTask', () => {
		const saveNote = (id: string, href: string, attributedTo = REMOTE) =>
			apex.store.saveObject({
				id,
				type: 'Note',
				attributedTo,
				content: `<p>read <a href="${href}">this</a></p>`,
				published: '2026-10-01T00:00:00Z',
				to: [PUBLIC],
			} as unknown as APObject);

		test('attaches the card and returns it in the Status', async () => {
			await apex.store.saveObject({
				id: REMOTE,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${REMOTE}/inbox`,
				outbox: `${REMOTE}/outbox`,
			} as unknown as APObject);
			const noteIri = `${REMOTE}/statuses/1`;
			await saveNote(noteIri, `${origin}/article`);

			await previewCardTask.run(makeTaskRequest({ noteIri }));

			const id = await getOrAssignMastodonId(noteIri, '2026-10-01T00:00:00Z');
			const response = await request(mastodon).get(`/api/v1/statuses/${id}`);
			expect(response.status).toBe(200);
			expect(response.body.card).toMatchObject({
				url: `${origin}/article`,
				title: 'Article',
				description: 'About it',
				type: 'link',
				provider_name: 'Example',
				html: '',
				image: `${origin}/image.png`,
				width: 800,
				height: 420,
				blurhash: expect.any(String),
			});

			// 編集でリンクが消えたら、写しが残っていても返さない
			await apex.store.updateObject(
				{ ...note('<p>edited</p>', { id: noteIri }) } as unknown as APObject,
				REMOTE,
				true,
			);
			const edited = await request(mastodon).get(`/api/v1/statuses/${id}`);
			expect(edited.body.card).toBeNull();
		});

		test('reuses the cached result for the same URL', async () => {
			await saveNote(`${REMOTE}/statuses/1`, `${origin}/no-image`);
			await saveNote(`${REMOTE}/statuses/2`, `${origin}/no-image`);
			await attachPreviewCard(`${REMOTE}/statuses/1`);
			await attachPreviewCard(`${REMOTE}/statuses/2`);
			expect(requestedPaths).toEqual(['/no-image']);
			const second = await apex.store.getObject(`${REMOTE}/statuses/2`, true);
			expect(second?._meta?.card).toMatchObject({ title: 'No image', image: null });
		});

		test('caches failures without attaching a card', async () => {
			await saveNote(`${REMOTE}/statuses/1`, `${origin}/missing`);
			await saveNote(`${REMOTE}/statuses/2`, `${origin}/missing`);
			await attachPreviewCard(`${REMOTE}/statuses/1`);
			await attachPreviewCard(`${REMOTE}/statuses/2`);
			expect(requestedPaths).toEqual(['/missing']);
			const stored = await apex.store.getObject(`${REMOTE}/statuses/1`, true);
			expect(stored?._meta?.card).toBeUndefined();
		});

		test('touches the timeline view version for local notes', async () => {
			const me = await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
			const noteIri = `${String(me.id)}/notes/1`;
			await saveNote(noteIri, `${origin}/no-image`, String(me.id));
			await attachPreviewCard(noteIri);
			const version = await ProjectionVersions(escapeFirestoreKey(String(me.id)))
				.doc(toFirestoreKey('timelineView'))
				.get();
			expect(version.exists).toBe(true);
		});
	});

	describe('requesting preview cards', () => {
		test('POST /api/v1/statuses requests a card for a link', async () => {
			vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);
			await createLocalActor('hakatashi', { uid: 'uid-hakatashi', id: '1' });
			await addAccessToken('write-token', 'read write', 'uid-hakatashi');

			const response = await request(mastodon)
				.post('/api/v1/statuses')
				.set('Authorization', 'Bearer write-token')
				.send({ status: 'look https://news.example/a' });
			expect(response.status).toBe(200);
			expect(response.body.card).toBeNull();
			expect(enqueueSpy).toHaveBeenCalledWith(response.body.uri, 'https://news.example/a');

			await request(mastodon)
				.post('/api/v1/statuses')
				.set('Authorization', 'Bearer write-token')
				.send({ status: 'no links' });
			expect(enqueueSpy).toHaveBeenCalledTimes(1);
		});

		test('an inbox Create of a note with a link requests a card', async () => {
			// inbox-dedup.spec.ts と同じ理由(Cloud Functions ランタイムの req.rawBody 前提の再現)。
			const wrapper = express();
			wrapper.use(
				express.raw({ type: () => true, limit: '10mb' }),
				(req, _res, next) => {
					(req as { rawBody?: unknown }).rawBody = req.body;
					req.body = (req.body as Buffer).toString('utf-8');
					next();
				},
				activitypub as unknown as express.RequestHandler,
			);
			const actor = await apex.createActor('hakatashi', 'hakatashi', '', '', 'Person');
			await apex.store.saveObject(actor);
			await apex.store.saveObject({
				id: REMOTE,
				type: 'Person',
				preferredUsername: 'alice',
				inbox: `${REMOTE}/inbox`,
				outbox: `${REMOTE}/outbox`,
			} as unknown as APObject);
			vi.spyOn(apex, 'resolveActivity').mockResolvedValue(undefined);
			vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true);
			const originalEnv = app.get('env') as string;
			// security.verifySignature は development env でのみ Signature ヘッダなしを許す。
			app.set('env', 'development');
			try {
				const noteIri = `${REMOTE}/statuses/9`;
				const response = await request(wrapper)
					.post('/activitypub/u/hakatashi/inbox')
					.set('Content-Type', 'application/activity+json')
					.send(
						JSON.stringify({
							'@context': AS_CONTEXT,
							id: `${noteIri}/activity`,
							type: 'Create',
							actor: REMOTE,
							to: [PUBLIC],
							object: {
								id: noteIri,
								type: 'Note',
								attributedTo: REMOTE,
								content: '<p><a href="https://news.example/b">news</a></p>',
								published: '2026-10-01T00:00:00Z',
								to: [PUBLIC],
							},
						}),
					);
				expect(response.status).toBe(200);
				expect(enqueueSpy).toHaveBeenCalledWith(noteIri, 'https://news.example/b');
			} finally {
				app.set('env', originalEnv);
			}
		});

		test('task IDs differ by URL', () => {
			expect(previewCardTaskId('https://a/1', 'https://x/')).not.toBe(
				previewCardTaskId('https://a/1', 'https://y/'),
			);
			expect(previewCardTaskId('https://a/1', 'https://x/')).toMatch(/^[\w-]+$/u);
		});
	});
});
