import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
	PUBLIC_PAGE_CSP,
	renderProfilePage,
	renderStatusPage,
	sanitizeContentHtml,
} from '../../src/mastodon/publicPageHtml.js';
import type { StatusPageInput } from '../../src/mastodon/publicPageHtml.js';

// リンクプレビュー用の最小限の HTML (→ ADR-0107)。
describe('sanitizeContentHtml', () => {
	test('keeps the markup produced for Mastodon content', () => {
		const html =
			'<p>hello<br />world <a href="https://example.com/a?b=1&amp;c=2" class="mention hashtag" rel="tag">#<span>tag</span></a></p>';
		expect(sanitizeContentHtml(html)).toBe(
			'<p>hello<br />world <a href="https://example.com/a?b=1&amp;c=2" rel="nofollow noopener noreferrer" target="_blank" class="mention hashtag">#<span>tag</span></a></p>',
		);
	});

	test('drops disallowed tags, event handlers and dangerous URLs', () => {
		expect(
			sanitizeContentHtml(
				'<p onclick="alert(1)">a<script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">b</a><a href=" jav&#x61;script:alert(1)">c</a></p>',
			),
		).toBe(
			'<p>aalert(1)<a rel="nofollow noopener noreferrer" target="_blank">b</a><a rel="nofollow noopener noreferrer" target="_blank">c</a></p>',
		);
	});

	test('escapes stray angle brackets and attribute quotes', () => {
		expect(
			sanitizeContentHtml('a < b <!-- c --> <a href="https://e.com/&quot;onmouseover=x">d</a>'),
		).toBe(
			'a &lt; b &lt;!-- c --&gt; <a href="https://e.com/%22onmouseover=x" rel="nofollow noopener noreferrer" target="_blank">d</a>',
		);
		expect(sanitizeContentHtml('<span class="x&quot; onclick=&quot;y">z</span>')).toBe(
			'<span>z</span>',
		);
	});

	test('closes unbalanced tags', () => {
		expect(sanitizeContentHtml('<p><a href="https://e.com/">x</p>y</span>')).toBe(
			'<p><a href="https://e.com/" rel="nofollow noopener noreferrer" target="_blank">x</a></p>y',
		);
		expect(sanitizeContentHtml('<p><span>x')).toBe('<p><span>x</span></p>');
	});
});

const author = {
	displayName: 'Hakata <shi>',
	acct: 'hakatashi@ap.example',
	avatarUrl: 'https://img.example/avatar.png',
	profileUrl: 'https://mastodon.example/@hakatashi',
};

const baseInput: StatusPageInput = {
	siteName: 'mastodon.example',
	author,
	url: 'https://mastodon.example/@hakatashi/00000000000000000001',
	activityPubIri: 'https://ap.example/activitypub/o/abc',
	elkUrl: 'https://elk.zone/mastodon.example/@hakatashi@ap.example/00000000000000000001',
	published: '2026-10-10T03:04:05.000Z',
	lang: 'ja',
	contentHtml: '<p>"hello" &amp; &lt;world&gt;</p>',
	contentText: '"hello" & <world>',
	spoilerText: '',
	sensitive: false,
	images: [],
	attachmentCount: 0,
};

const metaContent = (html: string, property: string) =>
	html.match(new RegExp(`<meta property="${property}" content="(?<content>[^"]*)" />`))?.groups
		?.content;

describe('renderStatusPage', () => {
	test('includes escaped OGP tags, the AP alternate link and the Elk link', () => {
		const html = renderStatusPage(baseInput);
		expect(metaContent(html, 'og:type')).toBe('article');
		expect(metaContent(html, 'og:site_name')).toBe('mastodon.example');
		expect(metaContent(html, 'og:title')).toBe('Hakata &lt;shi&gt; (@hakatashi@ap.example)');
		expect(metaContent(html, 'og:description')).toBe('&quot;hello&quot; &amp; &lt;world&gt;');
		expect(metaContent(html, 'og:url')).toBe(baseInput.url);
		expect(metaContent(html, 'og:published_time')).toBe(baseInput.published);
		expect(metaContent(html, 'og:image')).toBe(author.avatarUrl);
		expect(metaContent(html, 'twitter:card')).toBe('summary');
		expect(html).toContain(
			'<link rel="alternate" type="application/activity+json" href="https://ap.example/activitypub/o/abc" />',
		);
		expect(html).toContain(`<a id="elk-link" href="${baseInput.elkUrl}">`);
		expect(html).toContain('<p>"hello" &amp; &lt;world&gt;</p>');
		expect(html).not.toContain('<shi>');
	});

	test('prefers the CW for the description and hides the content behind it', () => {
		const html = renderStatusPage({
			...baseInput,
			spoilerText: 'spoiler <b>',
			images: [{ url: 'https://img.example/1.png' }],
			attachmentCount: 1,
		});
		expect(metaContent(html, 'og:description')).toBe('spoiler &lt;b&gt;');
		expect(metaContent(html, 'og:image')).toBe(author.avatarUrl);
		expect(html).toContain('<details>');
		expect(html).not.toContain('<img src="https://img.example/1.png"');
	});

	test('uses the first non-sensitive image as a large card', () => {
		const html = renderStatusPage({
			...baseInput,
			images: [
				{ url: 'https://img.example/1.png', alt: 'one', width: 640, height: 480 },
				{ url: 'https://img.example/2.png' },
			],
			attachmentCount: 2,
		});
		expect(metaContent(html, 'og:image')).toBe('https://img.example/1.png');
		expect(metaContent(html, 'og:image:width')).toBe('640');
		expect(metaContent(html, 'og:image:alt')).toBe('one');
		expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');

		const sensitive = renderStatusPage({
			...baseInput,
			sensitive: true,
			images: [{ url: 'https://img.example/1.png' }],
			attachmentCount: 1,
		});
		expect(metaContent(sensitive, 'og:image')).toBe(author.avatarUrl);
		expect(metaContent(sensitive, 'twitter:card')).toBe('summary');
	});

	test('the CSP hashes match the inline style and script', () => {
		const html = renderStatusPage(baseInput);
		const hash = (source: string) =>
			`'sha256-${createHash('sha256').update(source).digest('base64')}'`;
		const style = html.match(/<style>(?<source>[^<]*)<\/style>/)?.groups?.source;
		const script = html.match(/<script>(?<source>[^<]*)<\/script>/)?.groups?.source;
		expect(PUBLIC_PAGE_CSP).toContain(`style-src ${hash(style!)}`);
		expect(PUBLIC_PAGE_CSP).toContain(`script-src ${hash(script!)}`);
		expect(PUBLIC_PAGE_CSP).toContain("default-src 'none'");
	});
});

describe('renderProfilePage', () => {
	test('includes profile OGP tags', () => {
		const html = renderProfilePage({
			siteName: 'mastodon.example',
			author,
			activityPubIri: 'https://ap.example/activitypub/u/hakatashi',
			elkUrl: 'https://elk.zone/mastodon.example/@hakatashi@ap.example',
			summaryHtml: '<p>bio</p><script>x</script>',
			summaryText: 'bio',
		});
		expect(metaContent(html, 'og:type')).toBe('profile');
		expect(metaContent(html, 'og:url')).toBe(author.profileUrl);
		expect(metaContent(html, 'og:description')).toBe('bio');
		expect(html).toContain('<div class="content"><p>bio</p>x</div>');
	});
});
