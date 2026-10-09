import { createHash } from 'node:crypto';
import { escapeHtml } from './statusContent.js';

// リンクプレビュー用の最小限の HTML を組み立てる純粋関数群 (→ ADR-0107)。
// 人間向けの UI ではないので、OGP と本文・投稿者・日時・Elk へのリンクだけを持つ。

const ALLOWED_TAGS = new Set(['p', 'br', 'a', 'span']);
const VOID_TAGS = new Set(['br']);
const TAG_PATTERN =
	/<(?<closing>\/?)(?<tag>[a-z][a-z0-9]*)\b(?<attributes>(?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const ATTRIBUTE_PATTERN =
	/(?<name>[^\s"'>/=]+)(?:\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s"'=<>`]+)))?/g;
const CLASS_PATTERN = /^[\w\s-]*$/;

const decodeEntities = (text: string) =>
	text.replaceAll(
		/&(?<body>#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi,
		(entity, body: string) => {
			const lower = body.toLowerCase();
			if (lower.startsWith('#x')) {
				return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
			}
			if (lower.startsWith('#')) {
				return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
			}
			return (
				(
					{ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string | undefined>
				)[lower] ?? entity
			);
		},
	);

export const toSafeHttpUrl = (value: string | undefined): string | undefined => {
	if (value === undefined) {
		return undefined;
	}
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
	} catch {
		return undefined;
	}
};

const sanitizeAttributes = (tag: string, rawAttributes: string) => {
	const attributes = new Map<string, string>();
	for (const match of rawAttributes.matchAll(ATTRIBUTE_PATTERN)) {
		const { name, double, single, bare } = match.groups!;
		attributes.set(name!.toLowerCase(), decodeEntities(double ?? single ?? bare ?? ''));
	}
	let result = '';
	if (tag === 'a') {
		const href = toSafeHttpUrl(attributes.get('href'));
		if (href !== undefined) {
			result += ` href="${escapeHtml(href)}"`;
		}
		result += ' rel="nofollow noopener noreferrer" target="_blank"';
	}
	const className = attributes.get('class');
	if (className !== undefined && CLASS_PATTERN.test(className)) {
		result += ` class="${escapeHtml(className)}"`;
	}
	return result;
};

// 本文 HTML を許可リストでサニタイズする。許可しないタグは捨てて中身のテキストだけ残し、
// テキスト中の `<` `>` はエスケープする。閉じられていないタグは末尾で閉じる。
export const sanitizeContentHtml = (html: string): string => {
	const escapeText = (text: string) => text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
	const open: string[] = [];
	let result = '';
	let lastIndex = 0;
	for (const match of html.matchAll(TAG_PATTERN)) {
		result += escapeText(html.slice(lastIndex, match.index));
		lastIndex = match.index + match[0].length;
		const isClosing = match.groups!.closing === '/';
		const tag = match.groups!.tag!.toLowerCase();
		if (!ALLOWED_TAGS.has(tag)) {
			continue;
		}
		if (VOID_TAGS.has(tag)) {
			if (!isClosing) {
				result += `<${tag} />`;
			}
			continue;
		}
		if (isClosing) {
			const position = open.lastIndexOf(tag);
			if (position !== -1) {
				for (const closing of open.splice(position).toReversed()) {
					result += `</${closing}>`;
				}
			}
			continue;
		}
		open.push(tag);
		result += `<${tag}${sanitizeAttributes(tag, match.groups!.attributes ?? '')}>`;
	}
	result += escapeText(html.slice(lastIndex));
	for (const closing of open.toReversed()) {
		result += `</${closing}>`;
	}
	return result;
};

const STYLE = [
	':root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#f6f8fa;--card:#fff;--line:#d1d9e0;--link:#563acc}',
	'@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#161b22;--line:#30363d;--link:#a693ff}}',
	'*{box-sizing:border-box}',
	'body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}',
	'main{max-width:600px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}',
	'header{display:flex;gap:12px;align-items:center}',
	'.avatar{width:48px;height:48px;border-radius:8px;flex:none;object-fit:cover}',
	'.name{font-weight:700}.acct,.meta{color:var(--muted);font-size:14px;overflow-wrap:anywhere}',
	'.content{margin:16px 0;overflow-wrap:anywhere}.content p{margin:0 0 1em}.content p:last-child{margin:0}',
	'.cw{font-weight:700}details{margin:8px 0}summary{cursor:pointer;color:var(--muted)}',
	'.invisible{display:none}.ellipsis::after{content:"…"}',
	'.media{display:grid;gap:8px;margin:16px 0}.media img{width:100%;border-radius:8px}',
	'a{color:var(--link)}footer{display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;border-top:1px solid var(--line);padding-top:12px}',
].join('');

// Elk のクローラー判定 (app/plugins/social.server.ts) に当たらないときだけ Elk へ送る。
// クローラーには Elk が 301 でこのページへ戻すので、JS を実行するクローラーで往復しないようにする。
// 固定文字列にしておき、CSP のハッシュを一定に保つ。
const REDIRECT_SCRIPT =
	"(function(){var l=document.getElementById('elk-link');" +
	'if(l&&!/bot\\b|index|spider|facebookexternalhit|crawl|wget|slurp|mediapartners-google|whatsapp/i.test(navigator.userAgent)){location.replace(l.href);}})();';

const cspHash = (source: string) =>
	`'sha256-${createHash('sha256').update(source).digest('base64')}'`;

export const PUBLIC_PAGE_CSP = [
	"default-src 'none'",
	'img-src https: http:',
	`style-src ${cspHash(STYLE)}`,
	`script-src ${cspHash(REDIRECT_SCRIPT)}`,
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join('; ');

const truncate = (text: string, length: number) => {
	const chars = [...text];
	return chars.length > length ? `${chars.slice(0, length).join('')}…` : text;
};

const formatDate = (iso: string) => {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return iso;
	}
	return new Intl.DateTimeFormat('ja-JP', {
		timeZone: 'Asia/Tokyo',
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(date);
};

export interface PageAuthor {
	displayName: string;
	// `user@domain` の形
	acct: string;
	avatarUrl?: string | undefined;
	profileUrl: string;
}

export interface PageImage {
	url: string;
	alt?: string | undefined;
	mediaType?: string | undefined;
	width?: number | undefined;
	height?: number | undefined;
}

interface PageOptions {
	lang: string;
	title: string;
	siteName: string;
	ogType: 'article' | 'profile';
	ogTitle: string;
	description: string;
	url: string;
	activityPubIri: string;
	elkUrl: string;
	image?: PageImage | undefined;
	largeImage: boolean;
	extraMeta?: [string, string][];
	body: string;
}

const meta = (property: string, content: string) =>
	`<meta property="${escapeHtml(property)}" content="${escapeHtml(content)}" />`;

const renderPage = (options: PageOptions) => {
	const metas: [string, string][] = [
		['og:site_name', options.siteName],
		['og:type', options.ogType],
		['og:title', options.ogTitle],
		['og:description', options.description],
		['og:url', options.url],
		...(options.extraMeta ?? []),
	];
	if (options.image !== undefined) {
		metas.push(['og:image', options.image.url]);
		if (options.image.mediaType !== undefined) {
			metas.push(['og:image:type', options.image.mediaType]);
		}
		if (options.image.width !== undefined && options.image.height !== undefined) {
			metas.push(['og:image:width', String(options.image.width)]);
			metas.push(['og:image:height', String(options.image.height)]);
		}
		if (options.image.alt !== undefined && options.image.alt !== '') {
			metas.push(['og:image:alt', options.image.alt]);
		}
	}
	metas.push(['twitter:card', options.largeImage ? 'summary_large_image' : 'summary']);
	return [
		'<!DOCTYPE html>',
		`<html lang="${escapeHtml(options.lang)}">`,
		'<head>',
		'<meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`<title>${escapeHtml(options.title)}</title>`,
		`<meta name="description" content="${escapeHtml(options.description)}" />`,
		...metas.map(([property, content]) => meta(property, content)),
		`<link rel="canonical" href="${escapeHtml(options.url)}" />`,
		`<link rel="alternate" type="application/activity+json" href="${escapeHtml(options.activityPubIri)}" />`,
		`<style>${STYLE}</style>`,
		'</head>',
		'<body>',
		'<main>',
		options.body,
		'<footer>',
		`<a id="elk-link" href="${escapeHtml(options.elkUrl)}">Elk で開く</a>`,
		'</footer>',
		'</main>',
		`<script>${REDIRECT_SCRIPT}</script>`,
		'</body>',
		'</html>',
	].join('\n');
};

const renderAuthorHeader = (author: PageAuthor) => {
	const avatarUrl = toSafeHttpUrl(author.avatarUrl);
	return [
		'<header>',
		avatarUrl === undefined
			? ''
			: `<img class="avatar" src="${escapeHtml(avatarUrl)}" alt="" width="48" height="48" />`,
		'<div>',
		`<div class="name">${escapeHtml(author.displayName)}</div>`,
		`<div class="acct"><a href="${escapeHtml(author.profileUrl)}">@${escapeHtml(author.acct)}</a></div>`,
		'</div>',
		'</header>',
	].join('');
};

export interface StatusPageInput {
	siteName: string;
	author: PageAuthor;
	url: string;
	activityPubIri: string;
	elkUrl: string;
	published: string;
	lang: string | null;
	contentHtml: string;
	contentText: string;
	spoilerText: string;
	sensitive: boolean;
	images: PageImage[];
	// 画像以外も含めた添付の数
	attachmentCount: number;
}

export const renderStatusPage = (input: StatusPageInput): string => {
	const { author } = input;
	const hasCw = input.spoilerText !== '';
	const description = hasCw ? input.spoilerText : input.contentText;
	const showImages = !input.sensitive && !hasCw && input.images.length > 0;
	const avatarImage = author.avatarUrl === undefined ? undefined : { url: author.avatarUrl };
	const ogImage: PageImage | undefined = showImages ? input.images[0] : avatarImage;

	const content = `<div class="content">${sanitizeContentHtml(input.contentHtml)}</div>`;
	const media = showImages
		? `<div class="media">${input.images
				.map(
					(image) =>
						`<a href="${escapeHtml(image.url)}"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.alt ?? '')}" loading="lazy" /></a>`,
				)
				.join('')}</div>`
		: '';
	const hiddenMedia =
		!showImages && input.attachmentCount > 0
			? `<p class="meta">添付ファイル ${input.attachmentCount} 件</p>`
			: '';
	const body = hasCw
		? `<p class="cw">${escapeHtml(input.spoilerText)}</p><details><summary>もっと見る</summary>${content}${media}${hiddenMedia}</details>`
		: `${content}${media}${hiddenMedia}`;

	return renderPage({
		lang: input.lang ?? 'ja',
		title: `${author.displayName}: 「${truncate(description, 50)}」`,
		siteName: input.siteName,
		ogType: 'article',
		ogTitle: `${author.displayName} (@${author.acct})`,
		description,
		url: input.url,
		activityPubIri: input.activityPubIri,
		elkUrl: input.elkUrl,
		image: ogImage,
		largeImage: showImages,
		extraMeta: [['og:published_time', input.published]],
		body: [
			renderAuthorHeader(author),
			body,
			`<p class="meta"><a href="${escapeHtml(input.url)}"><time datetime="${escapeHtml(input.published)}">${escapeHtml(formatDate(input.published))}</time></a></p>`,
		].join(''),
	});
};

export interface ProfilePageInput {
	siteName: string;
	author: PageAuthor;
	activityPubIri: string;
	elkUrl: string;
	summaryHtml: string;
	summaryText: string;
}

export const renderProfilePage = (input: ProfilePageInput): string => {
	const { author } = input;
	return renderPage({
		lang: 'ja',
		title: `${author.displayName} (@${author.acct})`,
		siteName: input.siteName,
		ogType: 'profile',
		ogTitle: `${author.displayName} (@${author.acct})`,
		description: input.summaryText,
		url: author.profileUrl,
		activityPubIri: input.activityPubIri,
		elkUrl: input.elkUrl,
		image: author.avatarUrl === undefined ? undefined : { url: author.avatarUrl },
		largeImage: false,
		extraMeta: [['profile:username', author.acct]],
		body: [
			renderAuthorHeader(author),
			`<div class="content">${sanitizeContentHtml(input.summaryHtml)}</div>`,
		].join(''),
	});
};
