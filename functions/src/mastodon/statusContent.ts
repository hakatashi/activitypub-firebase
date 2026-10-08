export interface NoteTag {
	type: string;
	href: string;
	name: string;
	[key: string]: unknown;
}

export interface ResolvedMention {
	actorIri: string;
	url: string;
	username: string;
	domain?: string | undefined;
}

export interface ExtractedMention {
	raw: string;
	username: string;
	domain: string | undefined;
	indices: [number, number];
}

export interface ExtractedUrl {
	raw: string;
	url: string;
	indices: [number, number];
}

export interface ExtractedHashtag {
	raw: string;
	hashtag: string;
	indices: [number, number];
}

export type ExtractedEntity =
	| ({ type: 'url' } & ExtractedUrl)
	| ({ type: 'mention' } & ExtractedMention)
	| ({ type: 'hashtag' } & ExtractedHashtag);

export interface FormatPostContentOptions {
	// 解決できたメンションの対応表。キーは `@user` または `@user@domain` (小文字)。
	resolvedMentions?: Map<string, ResolvedMention> | Record<string, ResolvedMention> | undefined;
	// ハッシュタグのリンク先 URL 生成に使うドメイン (例: mastodon.hakatashi.com)
	mastodonDomain: string;
}

export interface FormattedPostContent {
	// Mastodon 互換の HTML (<p>, <br />, <a>, <span class="h-card"> 等)
	html: string;
	// Note の tag に格納する Mention / Hashtag オブジェクト群
	tags: NoteTag[];
	// 解決できたメンション先 actor の IRI 群 (重複なし、to / cc 配送用)
	mentionedActorIris: string[];
}

export const escapeHtml = (text: string): string =>
	text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

export const isSafeHttpUrl = (url: unknown): url is string => {
	if (typeof url !== 'string' || url.length === 0) {
		return false;
	}
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
};

const TRAILING_PUNCTUATION = new Set([
	'.',
	',',
	'!',
	'?',
	':',
	';',
	"'",
	'"',
	'>',
	'`',
	'」',
	'』',
	'）',
	'】',
	'〉',
	'》',
]);

// URL の末尾にある句読点や不均衡な括弧を取り除き、有効な URL であれば正規化して返す。
export const cleanUrl = (raw: string): { cleanedUrl: string; length: number } | undefined => {
	let url = raw;
	while (url.length > 0) {
		const lastChar = url.slice(-1);
		if (TRAILING_PUNCTUATION.has(lastChar)) {
			url = url.slice(0, -1);
			continue;
		}
		if (lastChar === ')') {
			const openCount = (url.match(/\(/g) ?? []).length;
			const closeCount = (url.match(/\)/g) ?? []).length;
			if (closeCount > openCount) {
				url = url.slice(0, -1);
				continue;
			}
		}
		if (lastChar === ']') {
			const openCount = (url.match(/\[/g) ?? []).length;
			const closeCount = (url.match(/\]/g) ?? []).length;
			if (closeCount > openCount) {
				url = url.slice(0, -1);
				continue;
			}
		}
		break;
	}

	if (url.length === 0 || url.includes('\\')) {
		return undefined;
	}

	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return undefined;
		}
		return { cleanedUrl: url, length: url.length };
	} catch {
		return undefined;
	}
};

const URL_REGEX =
	/https?:\/\/[^\s<>"'`「」『』()（）]+(?:\([^\s<>"'`「」『』()]+\)|[^\s<>"'`「」『』()（）])*/gi;

export const extractUrls = (text: string): ExtractedUrl[] => {
	const urls: ExtractedUrl[] = [];
	for (const match of text.matchAll(URL_REGEX)) {
		if (match.index === undefined) {
			continue;
		}
		const rawCandidate = match[0];
		const cleaned = cleanUrl(rawCandidate);
		if (cleaned === undefined) {
			continue;
		}
		const start = match.index;
		const end = start + cleaned.length;
		urls.push({
			raw: cleaned.cleanedUrl,
			url: cleaned.cleanedUrl,
			indices: [start, end],
		});
	}
	return urls;
};

// Mastodon の HASHTAG_RE に準拠:
// 先頭または空白に続き、# または ＃、文字(英数字・漢字・ひらがな・カタカナ等)を含み数字のみは不可。
const HASHTAG_REGEX =
	/(?<=^|[\s])[#＃](?<hashtag>[\p{L}\p{N}_\u00B7\u30FB\u200c]*\p{L}[\p{L}\p{N}_\u00B7\u30FB\u200c]*)/gu;

export const extractHashtags = (text: string): ExtractedHashtag[] => {
	const hashtags: ExtractedHashtag[] = [];
	for (const match of text.matchAll(HASHTAG_REGEX)) {
		if (match.index === undefined || match.groups?.hashtag === undefined) {
			continue;
		}
		const hashtag = match.groups.hashtag;
		// 1文字目は # または ＃
		const hashChar = text[match.index] ?? '#';
		const raw = `${hashChar}${hashtag}`;
		const start = match.index;
		const end = start + raw.length;
		hashtags.push({
			raw,
			hashtag,
			indices: [start, end],
		});
	}
	return hashtags;
};

// Mastodon の MENTION_RE に準拠:
// 直前が = / 単語文字でなく、@、英数字と記号のユーザー名、任意のリモートドメイン
const MENTION_REGEX =
	/(?<![=/a-zA-Z0-9_])@(?<mention>[a-zA-Z0-9_]+(?:[.-]+[a-zA-Z0-9_]+)*(?:@[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*(?::\d+)?)?)/gu;

export const extractMentions = (text: string): ExtractedMention[] => {
	const mentions: ExtractedMention[] = [];
	for (const match of text.matchAll(MENTION_REGEX)) {
		if (match.index === undefined || match.groups?.mention === undefined) {
			continue;
		}
		const content = match.groups.mention;
		const atIndex = content.indexOf('@');
		let username: string;
		let domain: string | undefined;
		if (atIndex === -1) {
			username = content;
			domain = undefined;
		} else {
			username = content.slice(0, atIndex);
			domain = content.slice(atIndex + 1);
		}

		// RFC 1035 ドメイン名長制限 (253文字超過は無効なメンションとして除外)
		if (domain !== undefined && (domain.length === 0 || domain.length > 253)) {
			continue;
		}

		const raw = domain === undefined ? `@${username}` : `@${username}@${domain}`;
		const start = match.index;
		const end = start + raw.length;
		mentions.push({
			raw,
			username,
			domain,
			indices: [start, end],
		});
	}
	return mentions;
};

// 重複するエンティティを除去する (URL を優先し、出現順に重なりを排除)。
export const removeOverlappingEntities = (entities: ExtractedEntity[]): ExtractedEntity[] => {
	const typePriority: Record<ExtractedEntity['type'], number> = {
		url: 1,
		mention: 2,
		hashtag: 3,
	};

	const sorted = [...entities].sort((a, b) => {
		if (a.indices[0] !== b.indices[0]) {
			return a.indices[0] - b.indices[0];
		}
		return typePriority[a.type] - typePriority[b.type];
	});

	const result: ExtractedEntity[] = [];
	let lastEnd = -1;

	for (const entity of sorted) {
		if (entity.indices[0] >= lastEnd) {
			result.push(entity);
			lastEnd = entity.indices[1];
		}
	}

	return result;
};

export const extractEntities = (text: string): ExtractedEntity[] => {
	const urls = extractUrls(text).map((e): ExtractedEntity => ({ type: 'url', ...e }));
	const hashtags = extractHashtags(text).map((e): ExtractedEntity => ({ type: 'hashtag', ...e }));
	const mentions = extractMentions(text).map((e): ExtractedEntity => ({ type: 'mention', ...e }));
	return removeOverlappingEntities([...urls, ...hashtags, ...mentions]);
};

const URL_PREFIX_REGEX = /^(?<prefix>https?:\/\/(?:www\.)?)/i;

// Mastodon の TextFormatter.shortened_link と同じ URL 表示構造。
export const formatShortenedUrl = (url: string): string => {
	const prefixMatch = url.match(URL_PREFIX_REGEX);
	const prefix = prefixMatch?.groups?.prefix ?? '';
	const rest = url.slice(prefix.length);

	let displayUrl = rest;
	let suffix = '';
	let cutoff = false;

	const chars = [...rest];
	if (chars.length > 30) {
		let displayChars = chars.slice(0, 30);
		let suffixChars = chars.slice(30);
		cutoff = true;
		// 省略記号を考慮して suffix が 1 文字なら切り捨てを戻す (Mastodon と同じ)
		if (suffixChars.length === 1) {
			displayChars = chars.slice(0, 31);
			suffixChars = [];
			cutoff = false;
		}
		displayUrl = displayChars.join('');
		suffix = suffixChars.join('');
	}

	const ellipsisClass = cutoff ? 'ellipsis' : '';
	return `<a href="${escapeHtml(url)}" target="_blank" rel="nofollow noopener noreferrer" translate="no"><span class="invisible">${escapeHtml(prefix)}</span><span class="${ellipsisClass}">${escapeHtml(displayUrl)}</span><span class="invisible">${escapeHtml(suffix)}</span></a>`;
};

// Mastodon の TextFormatter#link_to_hashtag と同じハッシュタグリンク。
export const formatHashtag = (
	hashtag: string,
	mastodonDomain: string,
): { html: string; tag: NoteTag } => {
	const url = `https://${mastodonDomain}/tags/${encodeURIComponent(hashtag)}`;
	const html = `<a href="${escapeHtml(url)}" class="mention hashtag" rel="tag">#<span>${escapeHtml(hashtag)}</span></a>`;
	const tag: NoteTag = {
		type: 'Hashtag',
		href: url,
		name: `#${hashtag}`,
	};
	return { html, tag };
};

// Mastodon の TextFormatter#link_to_mention と同じメンションリンク。
export const formatMention = (
	mention: ExtractedMention,
	resolved: ResolvedMention | undefined,
	withDomain = false,
): { html: string; tag?: NoteTag | undefined; actorIri?: string | undefined } => {
	if (resolved === undefined) {
		return { html: escapeHtml(mention.raw) };
	}

	let safeUrl: string | undefined;
	if (isSafeHttpUrl(resolved.url)) {
		safeUrl = resolved.url;
	} else if (isSafeHttpUrl(resolved.actorIri)) {
		safeUrl = resolved.actorIri;
	}

	if (safeUrl === undefined || !isSafeHttpUrl(resolved.actorIri)) {
		return { html: escapeHtml(mention.raw) };
	}

	const displayUsername =
		withDomain && resolved.domain !== undefined
			? `${resolved.username}@${resolved.domain}`
			: resolved.username;

	const html = `<span class="h-card" translate="no"><a href="${escapeHtml(safeUrl)}" class="u-url mention">@<span>${escapeHtml(displayUsername)}</span></a></span>`;
	const acct =
		resolved.domain === undefined
			? `@${resolved.username}`
			: `@${resolved.username}@${resolved.domain}`;
	const tag: NoteTag = {
		type: 'Mention',
		href: resolved.actorIri,
		name: acct,
	};
	return { html, tag, actorIri: resolved.actorIri };
};

// 改行と段落の整形。空行で <p> 分割、単一改行は <br />。
export const textToParagraphs = (html: string): string => {
	const trimmed = html.replaceAll('\r\n', '\n').trim();
	if (trimmed === '') {
		return '';
	}
	return trimmed
		.split(/\n(?:[^\S\r\n]*\n)+/)
		.map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br />')}</p>`)
		.join('');
};

export const formatPostContent = (
	text: string,
	options: FormatPostContentOptions,
): FormattedPostContent => {
	const entities = extractEntities(text);
	const resolvedMap =
		options.resolvedMentions instanceof Map
			? options.resolvedMentions
			: new Map(Object.entries(options.resolvedMentions ?? {}));

	// 同一投稿内で同じユーザー名を持つ異なるドメインのメンションがある場合、ドメイン付きで表示する (withDomain)
	const usernameCounts = new Map<string, Set<string | undefined>>();
	for (const entity of entities) {
		if (entity.type === 'mention') {
			const resolved =
				resolvedMap.get(entity.raw.toLowerCase()) ??
				resolvedMap.get(`@${entity.username.toLowerCase()}`);
			if (resolved !== undefined) {
				const lowerUsername = resolved.username.toLowerCase();
				const domains = usernameCounts.get(lowerUsername) ?? new Set();
				domains.add(resolved.domain?.toLowerCase());
				usernameCounts.set(lowerUsername, domains);
			}
		}
	}

	const tags: NoteTag[] = [];
	const seenTagKeys = new Set<string>();
	const mentionedActorIris = new Set<string>();

	let htmlResult = '';
	let lastIndex = 0;

	for (const entity of entities) {
		// エンティティの手前のプレーンテキストをエスケープして追加
		htmlResult += escapeHtml(text.slice(lastIndex, entity.indices[0]));
		lastIndex = entity.indices[1];

		switch (entity.type) {
			case 'url': {
				htmlResult += formatShortenedUrl(entity.url);
				break;
			}
			case 'hashtag': {
				const { html, tag } = formatHashtag(entity.hashtag, options.mastodonDomain);
				htmlResult += html;
				const tagKey = `hashtag:${entity.hashtag.toLowerCase()}`;
				if (!seenTagKeys.has(tagKey)) {
					seenTagKeys.add(tagKey);
					tags.push(tag);
				}
				break;
			}
			case 'mention': {
				const resolved =
					resolvedMap.get(entity.raw.toLowerCase()) ??
					resolvedMap.get(`@${entity.username.toLowerCase()}`);
				const lowerUsername = resolved?.username.toLowerCase() ?? entity.username.toLowerCase();
				const withDomain = (usernameCounts.get(lowerUsername)?.size ?? 0) > 1;

				const { html, tag, actorIri } = formatMention(entity, resolved, withDomain);
				htmlResult += html;
				if (tag !== undefined && actorIri !== undefined) {
					const tagKey = `mention:${actorIri}`;
					if (!seenTagKeys.has(tagKey)) {
						seenTagKeys.add(tagKey);
						tags.push(tag);
					}
					mentionedActorIris.add(actorIri);
				}
				break;
			}
		}
	}

	// 最後のエンティティ以降のプレーンテキストをエスケープして追加
	htmlResult += escapeHtml(text.slice(lastIndex));

	return {
		html: textToParagraphs(htmlResult),
		tags,
		mentionedActorIris: [...mentionedActorIris],
	};
};
