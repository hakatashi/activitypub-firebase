import { createHash } from 'node:crypto';
import { encode } from 'blurhash';
import firebase from 'firebase-admin';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import sharp from 'sharp';
import { request } from 'undici';
import { z } from 'zod';
import { apex } from '../apex.js';
import { assertSafeUrl, makePinnedAgent, maxRedirects } from '../apex/index.js';
import type { APObject, RemoteFetchPolicy } from '../apex/index.js';
import { db, escapeFirestoreKey, taskQueueName, toFirestoreKey } from '../firebase.js';
import { localActorId } from '../localActor.js';
import { Objects, PreviewCards } from '../schema.js';
import type { PreviewCard, PreviewCardImage } from '../schema.js';
import { getAttributedTo, isAPNote, toArray, toStringValue } from '../utils.js';
import { isTaskAlreadyExistsError } from './remoteActorCounts.js';
import { isLocalHost } from './remoteResolution.js';
import { touchTimelineViewVersion } from './timelines.js';

// 投稿本文のリンクのプレビューカードを非同期で取得し、Note の `_meta.card` に写す (→ ADR-0141)。

// サーバーレス環境でのメモリ滞留を防ぐ (→ ADR-0093)。
sharp.cache(false);
sharp.concurrency(1);

export const PREVIEW_CARD_QUEUE = 'previewCardTask';

// HTML は先頭のこれだけを読む (Mastodon も 1MB で打ち切る)。
export const PREVIEW_HTML_MAX_BYTES = 1024 * 1024;
export const PREVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PREVIEW_IMAGE_MAX_PIXELS = 16_777_216;
// 1 回の取得全体 (リダイレクトを含む) の上限。
const PREVIEW_FETCH_DEADLINE_MS = 15_000;

export const PREVIEW_CARD_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const PREVIEW_CARD_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_PROVIDER_NAME_LENGTH = 100;

const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const IMAGE_FORMATS = new Set(['jpeg', 'png', 'gif', 'webp', 'avif']);

type ParsedNode = DefaultTreeAdapterMap['node'];
type ParsedElement = DefaultTreeAdapterMap['element'];

const isElement = (node: ParsedNode): node is ParsedElement => 'tagName' in node;

const getAttribute = (element: ParsedElement, name: string) =>
	element.attrs.find((attr) => attr.name === name)?.value;

const tokensOf = (value: string | undefined) =>
	(value ?? '').toLowerCase().split(/\s+/u).filter(Boolean);

const parseHttpUrl = (value: string, base?: string | URL) => {
	try {
		const url = new URL(value, base);
		if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
			return undefined;
		}
		return url;
	} catch {
		return undefined;
	}
};

// メンション・ハッシュタグのリンク (Mastodon・Misskey の microformats)。
const SKIPPED_LINK_CLASSES = new Set(['mention', 'hashtag', 'u-url', 'h-card']);

const tagHrefs = (note: APObject) =>
	new Set(
		toArray<unknown>(note.tag).flatMap((tag) => {
			if (typeof tag !== 'object' || tag === null) {
				return [];
			}
			const { href } = tag as { href?: unknown };
			return toArray<unknown>(href)
				.map(toStringValue)
				.filter((value): value is string => value !== undefined);
		}),
	);

// Misskey の `_misskey_quote`、Fedibird の `quoteUri`、`quoteUrl`、FEP-044f の `quote`。
// JSON-LD の展開で接頭辞付きのキーになることがあるので末尾で見る。
const QUOTE_KEY_PATTERN = /(?:^|[:#/])(?:_misskey_quote|quoteUri|quoteUrl|quote)$/u;

const hasQuote = (note: APObject) =>
	Object.entries(note).some(
		([key, value]) => value !== null && value !== undefined && QUOTE_KEY_PATTERN.test(key),
	);

// 本文のリンクのうち、プレビューカードを作る URL を選ぶ (→ ADR-0141 決定2)。
// Mastodon がリモートの投稿に使う規則 (`FetchLinkCardService#parse_urls`) に揃える。
export const pickPreviewCardUrl = (note: APObject): string | undefined => {
	if (toArray(note.attachment).length > 0 || hasQuote(note)) {
		return undefined;
	}
	const content = toStringValue(note.content);
	if (content === undefined || !content.includes('<a')) {
		return undefined;
	}
	const skippedHrefs = tagHrefs(note);
	const visit = (node: ParsedNode, insideHCard: boolean): string | undefined => {
		if (!isElement(node) && !('childNodes' in node)) {
			return undefined;
		}
		let inHCard = insideHCard;
		if (isElement(node)) {
			const classes = tokensOf(getAttribute(node, 'class'));
			inHCard ||= classes.includes('h-card');
			if (node.tagName === 'a') {
				const href = getAttribute(node, 'href');
				const url = href === undefined ? undefined : parseHttpUrl(href);
				const skipped =
					inHCard ||
					tokensOf(getAttribute(node, 'rel')).includes('tag') ||
					classes.some((name) => SKIPPED_LINK_CLASSES.has(name)) ||
					(href !== undefined && skippedHrefs.has(href));
				if (url !== undefined && !skipped && !isLocalHost(url.host)) {
					return url.href;
				}
				return undefined;
			}
		}
		for (const child of node.childNodes) {
			const found = visit(child, inHCard);
			if (found !== undefined) {
				return found;
			}
		}
		return undefined;
	};
	return visit(parseFragment(content), false);
};

// ----- 取得 (SSRF 対策 → ADR-0141 決定3) -----

// アドレスの範囲は apex と同じポリシーに従い、スキームだけ http も許す。
const previewFetchPolicy = (): RemoteFetchPolicy => {
	const base = apex.settings?.remoteFetchPolicy;
	const resolved = (typeof base === 'function' ? base() : base) ?? {};
	return { ...resolved, allowedProtocols: ['https:', 'http:'] };
};

const headerValue = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

const parseContentType = (value: string | undefined) => {
	const [mediaType = '', ...params] = (value ?? '').split(';');
	const charset = params
		.map((param) => /^\s*charset\s*=\s*"?(?<charset>[^";\s]+)"?\s*$/iu.exec(param))
		.find((match) => match !== null)?.groups?.charset;
	return { mediaType: mediaType.trim().toLowerCase(), charset };
};

interface FetchedResource {
	url: URL;
	mediaType: string;
	charset: string | undefined;
	body: Buffer;
}

interface FetchOptions {
	accept: string;
	acceptsMediaType: (mediaType: string) => boolean;
	maxBytes: number;
	// 上限を超えたら先頭だけを使う (HTML)。偽なら捨てる (画像)。
	truncate: boolean;
}

const readBody = async (
	body: AsyncIterable<unknown>,
	maxBytes: number,
	truncate: boolean,
): Promise<Buffer | undefined> => {
	const chunks: Buffer[] = [];
	let total = 0;
	// ループを抜けると for await...of が body を破棄する
	for await (const chunk of body) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		if (total + buffer.byteLength > maxBytes) {
			if (!truncate) {
				return undefined;
			}
			chunks.push(buffer.subarray(0, maxBytes - total));
			total = maxBytes;
			break;
		}
		chunks.push(buffer);
		total += buffer.byteLength;
	}
	return Buffer.concat(chunks);
};

// リダイレクトの各ホップで URL を検証し、検証済みの IP に接続を固定して GET する。
// 署名・Cookie・Authorization は付けない。失敗はすべて undefined にする。
const fetchSafely = async (
	target: string,
	options: FetchOptions,
): Promise<FetchedResource | undefined> => {
	const guardOptions = { policy: previewFetchPolicy, logger: apex.logger };
	const signal = AbortSignal.timeout(PREVIEW_FETCH_DEADLINE_MS);
	try {
		let { url, addresses } = await assertSafeUrl(target, guardOptions);
		for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
			const agent = makePinnedAgent(addresses);
			try {
				const response = await request(url, {
					method: 'GET',
					headers: {
						Accept: options.accept,
						'Accept-Language': 'ja, *;q=0.5',
						'User-Agent': `${apex.makeUserAgentString()} Bot`,
					},
					headersTimeout: apex.requestTimeout,
					bodyTimeout: apex.requestTimeout,
					dispatcher: agent,
					signal,
				});
				if (response.statusCode >= 300 && response.statusCode < 400) {
					const location = headerValue(response.headers.location);
					await response.body.dump();
					if (location === undefined || location === '') {
						return undefined;
					}
					({ url, addresses } = await assertSafeUrl(
						new URL(location, url).toString(),
						guardOptions,
					));
					continue;
				}
				const { mediaType, charset } = parseContentType(
					headerValue(response.headers['content-type']),
				);
				const contentLength = Number(headerValue(response.headers['content-length']));
				if (
					response.statusCode !== 200 ||
					!options.acceptsMediaType(mediaType) ||
					(!options.truncate && contentLength > options.maxBytes)
				) {
					await response.body.dump();
					logger.info({
						type: 'previewCardFetchRejected',
						url: url.toString(),
						statusCode: response.statusCode,
						mediaType,
					});
					return undefined;
				}
				const body = await readBody(response.body, options.maxBytes, options.truncate);
				return body === undefined ? undefined : { url, mediaType, charset, body };
			} finally {
				await agent.close();
			}
		}
		logger.info({ type: 'previewCardTooManyRedirects', url: target });
		return undefined;
	} catch (error) {
		logger.info({
			type: 'previewCardFetchFailed',
			url: target,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
};

// ----- 解析 (→ ADR-0141 決定4) -----

const decodeWith = (body: Buffer, label: string | undefined) => {
	if (label === undefined) {
		return undefined;
	}
	try {
		return new TextDecoder(label).decode(body);
	} catch {
		return undefined;
	}
};

// `<meta charset>` / `<meta http-equiv="Content-Type">` を先頭 1024 バイトから探す (HTML の prescan の簡易版)。
const sniffMetaCharset = (body: Buffer) => {
	const head = body.subarray(0, 1024).toString('latin1');
	return /<meta[^>]+charset\s*=\s*["']?(?<charset>[\w.:-]+)/iu.exec(head)?.groups?.charset;
};

export const decodeHtml = (body: Buffer, headerCharset: string | undefined) =>
	decodeWith(body, headerCharset) ??
	decodeWith(body, sniffMetaCharset(body)) ??
	new TextDecoder('utf-8').decode(body);

const textContent = (node: ParsedNode): string => {
	if (node.nodeName === '#text' && 'value' in node) {
		return node.value;
	}
	return 'childNodes' in node ? node.childNodes.map(textContent).join('') : '';
};

const findChild = (node: ParsedNode, tagName: string) =>
	'childNodes' in node
		? node.childNodes.find(
				(child): child is ParsedElement => isElement(child) && child.tagName === tagName,
			)
		: undefined;

const normalizeText = (value: string | undefined, maxLength: number) => {
	const text = value?.replaceAll(/\s+/gu, ' ').trim();
	if (text === undefined || text === '') {
		return undefined;
	}
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};

export interface ParsedPreview {
	title: string;
	description: string;
	providerName: string;
	image: { url: string; description: string } | undefined;
}

// `<head>` の OGP などから題名・説明・画像・提供元を取り出す。題名が無ければ undefined。
export const parsePreviewHtml = (html: string, pageUrl: URL): ParsedPreview | undefined => {
	const root = findChild(parse(html), 'html');
	const head = root === undefined ? undefined : findChild(root, 'head');
	if (head === undefined) {
		return undefined;
	}
	const metas = new Map<string, string>();
	let titleElement: ParsedElement | undefined;
	for (const child of head.childNodes) {
		if (!isElement(child)) {
			continue;
		}
		if (child.tagName === 'title') {
			titleElement ??= child;
			continue;
		}
		if (child.tagName !== 'meta') {
			continue;
		}
		const key = (getAttribute(child, 'property') ?? getAttribute(child, 'name'))?.toLowerCase();
		const content = getAttribute(child, 'content');
		if (key !== undefined && content !== undefined && !metas.has(key)) {
			metas.set(key, content);
		}
	}
	const title = normalizeText(
		metas.get('og:title') ??
			metas.get('twitter:title') ??
			(titleElement === undefined ? undefined : textContent(titleElement)),
		MAX_TITLE_LENGTH,
	);
	if (title === undefined) {
		return undefined;
	}
	const imageUrl = [metas.get('og:image'), metas.get('og:image:url'), metas.get('twitter:image')]
		.map((value) => (value === undefined ? undefined : parseHttpUrl(value.trim(), pageUrl)))
		.find((url) => url !== undefined);
	return {
		title,
		description:
			normalizeText(
				metas.get('og:description') ?? metas.get('twitter:description') ?? metas.get('description'),
				MAX_DESCRIPTION_LENGTH,
			) ?? '',
		providerName: normalizeText(metas.get('og:site_name'), MAX_PROVIDER_NAME_LENGTH) ?? '',
		image:
			imageUrl === undefined
				? undefined
				: {
						url: imageUrl.href,
						description:
							normalizeText(
								metas.get('og:image:alt') ?? metas.get('twitter:image:alt'),
								MAX_DESCRIPTION_LENGTH,
							) ?? '',
					},
	};
};

// 画像は複製せず、幅・高さ・blurhash を出すためだけに読む (→ ADR-0141 決定5)。
const measureImage = async (
	url: string,
): Promise<Omit<PreviewCardImage, 'url' | 'description'> | undefined> => {
	const fetched = await fetchSafely(url, {
		accept: 'image/*',
		acceptsMediaType: (mediaType) =>
			mediaType.startsWith('image/') && mediaType !== 'image/svg+xml',
		maxBytes: PREVIEW_IMAGE_MAX_BYTES,
		truncate: false,
	});
	if (fetched === undefined) {
		return undefined;
	}
	try {
		const options = { limitInputPixels: PREVIEW_IMAGE_MAX_PIXELS, pages: 1 };
		const metadata = await sharp(fetched.body, options).metadata();
		const { format, width, height } = metadata;
		if (format === undefined || !IMAGE_FORMATS.has(format) || !width || !height) {
			return undefined;
		}
		let blurhash: string | null = null;
		try {
			const sample = await sharp(fetched.body, options)
				.rotate()
				.resize(32, 32, { fit: 'inside' })
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true });
			blurhash = encode(
				new Uint8ClampedArray(sample.data),
				sample.info.width,
				sample.info.height,
				4,
				3,
			);
		} catch {
			// blurhash が作れなくても幅・高さは返す
		}
		// EXIF の Orientation で縦横が入れ替わる画像は、表示上の向きに合わせる。
		const rotated = (metadata.orientation ?? 1) >= 5;
		return {
			width: rotated ? height : width,
			height: rotated ? width : height,
			blurhash,
		};
	} catch (error) {
		logger.info({
			type: 'previewCardImageInvalid',
			url,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
};

// URL のページを取得してプレビューカードを作る。作れなければ null。
export const fetchPreviewCard = async (url: string): Promise<PreviewCard | null> => {
	const fetched = await fetchSafely(url, {
		accept: 'text/html, application/xhtml+xml;q=0.9',
		acceptsMediaType: (mediaType) => HTML_CONTENT_TYPES.has(mediaType),
		maxBytes: PREVIEW_HTML_MAX_BYTES,
		truncate: true,
	});
	if (fetched === undefined) {
		return null;
	}
	const parsed = parsePreviewHtml(decodeHtml(fetched.body, fetched.charset), fetched.url);
	if (parsed === undefined) {
		return null;
	}
	const measured = parsed.image === undefined ? undefined : await measureImage(parsed.image.url);
	return {
		url,
		title: parsed.title,
		description: parsed.description,
		providerName: parsed.providerName,
		image:
			parsed.image === undefined || measured === undefined
				? null
				: { ...parsed.image, ...measured },
	};
};

// ----- 保存 (→ ADR-0141 決定6) -----

const previewCardKey = (url: string) =>
	toFirestoreKey(createHash('sha256').update(url).digest('hex'));

// URL ごとのキャッシュを見て、古ければ取り直す。
export const getOrFetchPreviewCard = async (
	url: string,
	now = Date.now(),
): Promise<PreviewCard | null> => {
	const ref = PreviewCards.doc(previewCardKey(url));
	const cached = (await ref.get()).data();
	if (cached?.url === url) {
		const ttl = cached.card === null ? PREVIEW_CARD_FAILURE_TTL_MS : PREVIEW_CARD_TTL_MS;
		if (now - cached.fetchedAt.toMillis() < ttl) {
			return cached.card;
		}
	}
	const card = await fetchPreviewCard(url);
	const ttl = card === null ? PREVIEW_CARD_FAILURE_TTL_MS : PREVIEW_CARD_TTL_MS;
	await ref.set({
		url,
		card,
		fetchedAt: firebase.firestore.Timestamp.fromMillis(now),
		expiresAt: firebase.firestore.Timestamp.fromMillis(now + ttl),
	});
	return card;
};

const cardPath = new firebase.firestore.FieldPath('_meta', 'card');

// Note の `_meta.card` を書き換える。本文が変わって対象の URL が変わっていれば何もしない。
// 書き換えたら true。
const writeNoteCard = (noteIri: string, url: string | undefined, card: PreviewCard | null) =>
	db.runTransaction(async (transaction) => {
		const ref = Objects.doc(escapeFirestoreKey(noteIri));
		const note = (await transaction.get(ref)).data();
		if (!isAPNote(note) || pickPreviewCardUrl(note) !== url) {
			return false;
		}
		if (card === null) {
			if (note._meta?.card === undefined) {
				return false;
			}
			transaction.update(ref, cardPath, firebase.firestore.FieldValue.delete());
			return true;
		}
		transaction.update(ref, cardPath, card);
		return true;
	});

// タスクの本体。Note の今の本文から URL を選び直し、カードを `_meta.card` に写す。
export const attachPreviewCard = async (noteIri: string) => {
	const note = await apex.store.getObject(noteIri, true);
	if (!isAPNote(note)) {
		logger.info({ type: 'previewCardSkipped', noteIri, reason: 'not-a-note' });
		return;
	}
	const url = pickPreviewCardUrl(note);
	const card = url === undefined ? null : await getOrFetchPreviewCard(url);
	const written = await writeNoteCard(noteIri, url, card);
	logger.info({ type: 'previewCardAttached', noteIri, url, found: card !== null, written });
	// ローカルの投稿は、ホームの先頭ページのキャッシュにすぐ出す (→ ADR-0139、ADR-0141 決定6)。
	if (written && getAttributedTo(note) === localActorId) {
		await touchTimelineViewVersion(localActorId);
	}
};

// ----- 依頼 (→ ADR-0141 決定1) -----

export const previewCardTaskId = (noteIri: string, url: string) =>
	`preview-card-${createHash('sha256').update(`${noteIri}\n${url}`).digest('hex').slice(0, 40)}`;

// テストで差し替えられるよう、enqueue はオブジェクトのメソッドにしておく。
export const previewCardQueue = {
	enqueue: async (noteIri: string, url: string) => {
		await getFunctions()
			.taskQueue(taskQueueName(PREVIEW_CARD_QUEUE))
			.enqueue({ noteIri }, { id: previewCardTaskId(noteIri, url) });
	},
};

// Note の本文にカードを作るリンクがあれば、取得をタスクに頼む。失敗しても呼び出し元には投げない。
export const requestPreviewCard = async (note: APObject | string | undefined) => {
	if (typeof note !== 'object' || !isAPNote(note) || typeof note.id !== 'string') {
		return;
	}
	const noteIri = note.id;
	try {
		const url = pickPreviewCardUrl(note);
		if (url === undefined) {
			return;
		}
		await previewCardQueue.enqueue(noteIri, url);
	} catch (error) {
		if (isTaskAlreadyExistsError(error)) {
			return;
		}
		logger.warn({
			type: 'previewCardEnqueueFailed',
			noteIri,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

// ----- 読み出し -----

const storedCardSchema = z.object({
	url: z.string(),
	title: z.string(),
	description: z.string(),
	providerName: z.string(),
	image: z
		.object({
			url: z.string(),
			width: z.number(),
			height: z.number(),
			blurhash: z.string().nullable(),
			description: z.string(),
		})
		.nullable(),
});

// Note の `_meta.card` のうち、今の本文から選んだ URL のものだけを返す (→ ADR-0141 決定6)。
export const noteToPreviewCard = (note: APObject): PreviewCard | undefined => {
	const stored = note._meta?.card;
	if (stored === undefined) {
		return undefined;
	}
	const parsed = storedCardSchema.safeParse(stored);
	if (!parsed.success || pickPreviewCardUrl(note) !== parsed.data.url) {
		return undefined;
	}
	return parsed.data;
};
