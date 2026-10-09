import type { APNote } from 'activitypub-types';
import type { mastodon } from 'masto';
import {
	guessFollowersIri,
	isNotePublicTimelineEligible,
	isNoteVisibleTo,
	noteToVisibility,
} from '../social/visibility.js';
import { domain } from '../firebase.js';
import type { CamelToSnake } from '../utils.js';
import { toArray, toStringValue } from '../utils.js';

export { guessFollowersIri, isNotePublicTimelineEligible, isNoteVisibleTo, noteToVisibility };

// `contentMap` の最初の言語タグ。無ければ null (Mastodon も不明なら null)。
export const noteToLanguage = (note: APNote): string | null => {
	const contentMap: unknown = note.contentMap;
	if (typeof contentMap !== 'object' || contentMap === null) {
		return null;
	}
	return Object.keys(contentMap)[0] ?? null;
};

// `updated` が `published` と異なるときだけ編集済みとみなす。
export const noteToEditedAt = (note: APNote): string | null => {
	const updated = toStringValue(note.updated) ?? (note.updated ? String(note.updated) : undefined);
	const published = note.published === undefined ? undefined : String(note.published);
	if (updated === undefined || updated === published) {
		return null;
	}
	return updated;
};

const toTotalItems = (collection: unknown): number | undefined => {
	if (typeof collection !== 'object' || collection === null || !('totalItems' in collection)) {
		return undefined;
	}
	const { totalItems } = collection;
	return typeof totalItems === 'number' ? totalItems : undefined;
};

// 受信した Like / Announce は `_meta` の非正規化カウンタが正 (→ ADR-0037)。
// 無ければ Note 自身が公開しているコレクションの totalItems にフォールバックする。
// 返信数は手元の返信の数 (`_meta.repliesCount`) と受信した totalItems の大きい方 (→ ADR-0102)。
export const noteToCounts = (
	note: APNote,
	meta?: { likesCount?: number; sharesCount?: number; repliesCount?: number },
) => ({
	replies_count: Math.max(meta?.repliesCount ?? 0, toTotalItems(note.replies) ?? 0),
	reblogs_count: meta?.sharesCount ?? toTotalItems(note.shares) ?? 0,
	favourites_count: meta?.likesCount ?? toTotalItems(note.likes) ?? 0,
});

type TagLike = { type?: unknown; name?: unknown; href?: unknown; icon?: unknown };

const isTagLike = (tag: unknown): tag is TagLike =>
	typeof tag === 'object' && tag !== null && !Array.isArray(tag);

const toTags = (note: APNote): TagLike[] => toArray<unknown>(note.tag).filter(isTagLike);

const hasType = (tag: TagLike, type: string) => toArray(tag.type).includes(type);

export const getMentionIris = (note: APNote): string[] =>
	toTags(note).flatMap((tag) => {
		const href = toStringValue(tag.href);
		if (!hasType(tag, 'Mention') || href === undefined) {
			return [];
		}
		return [href];
	});

// Mention タグから mentions を組み立てる。`name` は `@user` か `@user@host`。
// アカウント ID は `mentionIds` (IRI → ID の Map または Record) から引き、
// 未解決の場合は後方互換性のため外部アカウントのプレースホルダ ID (`'1'`) を入れる (→ ADR-0069)。
export const noteToMentions = (
	note: APNote,
	mentionIds?: Map<string, string> | Record<string, string>,
): mastodon.v1.StatusMention[] =>
	toTags(note).flatMap((tag) => {
		const href = toStringValue(tag.href);
		const name = toStringValue(tag.name);
		if (!hasType(tag, 'Mention') || href === undefined || name === undefined) {
			return [];
		}
		const [username = '', host] = name.replace(/^@/, '').split('@');
		const acct = host === undefined ? username : `${username}@${host}`;
		const id = mentionIds instanceof Map ? mentionIds.get(href) : mentionIds?.[href];
		return [{ id: id ?? '1', username, url: href, acct }];
	});

export const noteToHashtags = (note: APNote): mastodon.v1.Tag[] =>
	toTags(note).flatMap((tag) => {
		const href = toStringValue(tag.href);
		const name = toStringValue(tag.name);
		if (!hasType(tag, 'Hashtag') || href === undefined || name === undefined) {
			return [];
		}
		return [{ name: name.replace(/^#/, ''), url: href }];
	});

export const noteToEmojis = (note: APNote): CamelToSnake<mastodon.v1.CustomEmoji>[] =>
	toTags(note).flatMap((tag) => {
		const name = toStringValue(tag.name);
		const icon = tag.icon;
		const url =
			typeof icon === 'object' && icon !== null && 'url' in icon
				? toStringValue(icon.url)
				: undefined;
		if (!hasType(tag, 'Emoji') || name === undefined || url === undefined) {
			return [];
		}
		return [
			{
				shortcode: name.replace(/^:|:$/g, ''),
				url,
				static_url: url,
				visible_in_picker: true,
			},
		];
	});

export interface StatusViewerContext {
	favourited?: boolean | ReadonlySet<string> | undefined;
	reblogged?: boolean | ReadonlySet<string> | undefined;
	bookmarked?: boolean | ReadonlySet<string> | undefined;
	pinned?: boolean | ReadonlySet<string> | undefined;
}

const resolveViewerFlag = (
	flag: boolean | ReadonlySet<string> | undefined,
	noteId: string,
): boolean => {
	if (typeof flag === 'boolean') {
		return flag;
	}
	if (flag !== undefined) {
		return flag.has(noteId);
	}
	return false;
};

// 認証ユーザー (viewer) と Note の関係から Status のインタラクション属性を導出する (→ ADR-0070)。
// Note ID をキーとして Set から判定するか、単一 Note 用に boolean を直接受け取る。
export const noteToViewerAttributes = (note: APNote, viewerContext?: StatusViewerContext) => {
	const noteId = note.id ?? '';
	return {
		favourited: resolveViewerFlag(viewerContext?.favourited, noteId),
		reblogged: resolveViewerFlag(viewerContext?.reblogged, noteId),
		bookmarked: resolveViewerFlag(viewerContext?.bookmarked, noteId),
		pinned: resolveViewerFlag(viewerContext?.pinned, noteId),
	};
};

export type MediaAttachmentEntity = Omit<
	CamelToSnake<mastodon.v1.MediaAttachment>,
	'preview_url'
> & {
	preview_url: string | null;
};

const toValidHttpUrl = (url: unknown): string | undefined => {
	if (typeof url !== 'string') {
		return undefined;
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
			return parsed.href;
		}
	} catch {
		return undefined;
	}
	return undefined;
};

interface ExtractedMediaUrl {
	url: string;
	mediaType?: string | undefined;
}

const extractUrlAndMediaType = (urlValue: unknown): ExtractedMediaUrl | undefined => {
	for (const candidate of toArray(urlValue)) {
		if (typeof candidate === 'string') {
			const valid = toValidHttpUrl(candidate);
			if (valid !== undefined) {
				return { url: valid };
			}
		} else if (typeof candidate === 'object' && candidate !== null) {
			const record = candidate as Record<string, unknown>;
			const href = toStringValue(record.href) ?? toStringValue(record.url);
			const valid = href ? toValidHttpUrl(href) : undefined;
			if (valid !== undefined) {
				const mediaType = toStringValue(record.mediaType);
				return { url: valid, mediaType };
			}
		}
	}
	return undefined;
};

const extractPreviewUrl = (iconValue: unknown): string | null => {
	for (const candidate of toArray(iconValue)) {
		if (typeof candidate === 'string') {
			const valid = toValidHttpUrl(candidate);
			if (valid !== undefined) {
				return valid;
			}
		} else if (typeof candidate === 'object' && candidate !== null) {
			const record = candidate as Record<string, unknown>;
			const href = toStringValue(record.url) ?? toStringValue(record.href);
			const valid = href ? toValidHttpUrl(href) : undefined;
			if (valid !== undefined) {
				return valid;
			}
		}
	}
	return null;
};

const extractBlurhash = (item: Record<string, unknown>): string | null => {
	const candidates = [
		item['http://joinmastodon.org/ns#blurhash'],
		item['toot:blurhash'],
		item.blurhash,
	];
	for (const candidate of candidates) {
		const val = toStringValue(toArray(candidate)[0]);
		if (val !== undefined && val.length > 0 && /^[\w#$%*+,-.:;=?@[\]^{|}~]+$/.test(val)) {
			return val;
		}
	}
	return null;
};

const extractFocalPoint = (item: Record<string, unknown>): { x: number; y: number } | undefined => {
	const candidates = [
		item['http://joinmastodon.org/ns#focalPoint'],
		item['toot:focalPoint'],
		item.focalPoint,
	];
	for (const candidate of candidates) {
		if (candidate === undefined || candidate === null) {
			continue;
		}
		if (
			Array.isArray(candidate) &&
			candidate.length >= 2 &&
			typeof candidate[0] === 'number' &&
			typeof candidate[1] === 'number'
		) {
			const x = candidate[0];
			const y = candidate[1];
			if (Number.isFinite(x) && Number.isFinite(y)) {
				return { x, y };
			}
		}
		for (const entry of toArray(candidate)) {
			if (Array.isArray(entry) && entry.length >= 2) {
				const x = Number(entry[0]);
				const y = Number(entry[1]);
				if (Number.isFinite(x) && Number.isFinite(y)) {
					return { x, y };
				}
			} else if (typeof entry === 'object' && entry !== null) {
				const record = entry as Record<string, unknown>;
				if (Array.isArray(record['@list']) && record['@list'].length >= 2) {
					const x = Number(record['@list'][0]);
					const y = Number(record['@list'][1]);
					if (Number.isFinite(x) && Number.isFinite(y)) {
						return { x, y };
					}
				} else if ('x' in record && 'y' in record) {
					const x = Number(record.x);
					const y = Number(record.y);
					if (Number.isFinite(x) && Number.isFinite(y)) {
						return { x, y };
					}
				}
			}
		}
	}
	return undefined;
};

const extractDimension = (val: unknown): number | undefined => {
	const first = toArray(val)[0];
	if (typeof first === 'number' && Number.isFinite(first) && first > 0) {
		return Math.round(first);
	}
	if (typeof first === 'string') {
		const parsed = Number.parseInt(first, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
};

const ALLOWED_ATTACHMENT_TYPES = new Set(['Document', 'Image', 'Video', 'Audio']);

// Note の attachment から Mastodon API の MediaAttachment を導出する (→ ADR-0090)。
export const noteToMediaAttachments = (
	note: APNote,
	statusId: string,
	options: { isLocal?: boolean } = {},
): MediaAttachmentEntity[] => {
	const attachments = toArray<unknown>(note.attachment);
	const results: MediaAttachmentEntity[] = [];

	let index = 0;
	for (const rawItem of attachments) {
		if (typeof rawItem !== 'object' || rawItem === null) {
			continue;
		}
		const item = rawItem as Record<string, unknown>;

		const types = toArray<unknown>(item.type)
			.map(toStringValue)
			.filter((t): t is string => t !== undefined);
		if (!types.some((t) => ALLOWED_ATTACHMENT_TYPES.has(t))) {
			continue;
		}

		const extracted = extractUrlAndMediaType(item.url);
		if (extracted === undefined) {
			continue;
		}

		const mediaType = toStringValue(toArray(item.mediaType)[0]) ?? extracted.mediaType;
		let type: 'image' | 'video' | 'gifv' | 'audio' | 'unknown' = 'unknown';

		if (mediaType !== undefined) {
			const lower = mediaType.toLowerCase();
			if (lower.startsWith('image/')) {
				type = 'image';
			} else if (lower.startsWith('video/')) {
				type = 'video';
			} else if (lower.startsWith('audio/')) {
				type = 'audio';
			}
		}

		if (type === 'unknown') {
			if (types.includes('Image')) {
				type = 'image';
			} else if (types.includes('Video')) {
				type = 'video';
			} else if (types.includes('Audio')) {
				type = 'audio';
			}
		}

		const isLocal =
			options.isLocal ?? (typeof note.id === 'string' && note.id.startsWith(`https://${domain}/`));
		const url = extracted.url;
		const remoteUrl = isLocal ? null : url;

		let previewUrl: string | null = null;
		if (type === 'image') {
			previewUrl = extractPreviewUrl(item.icon) ?? url;
		} else {
			previewUrl = extractPreviewUrl(item.icon) ?? extractPreviewUrl(item.preview);
		}

		const description =
			toStringValue(toArray(item.name)[0]) ?? toStringValue(toArray(item.summary)[0]) ?? null;
		const blurhash = extractBlurhash(item);

		const width = extractDimension(item.width);
		const height = extractDimension(item.height);
		const focus = extractFocalPoint(item);

		let meta: CamelToSnake<mastodon.v1.MediaAttachment>['meta'] = null;
		if (width !== undefined && height !== undefined) {
			const aspect = width / height;
			const original = { width, height, size: `${width}x${height}`, aspect };
			meta = {
				original,
				small: original,
			};
		}
		if (focus !== undefined) {
			meta = meta ? { ...meta, focus } : { focus };
		}

		let attachmentId = `${statusId}${index}`;
		if (isLocal) {
			const match = url.match(/\/media_attachments\/files\/(?<id>[0-9]+)\//);
			if (match?.groups?.id) {
				attachmentId = match.groups.id;
			} else {
				const itemId = toStringValue(item.id);
				if (itemId !== undefined && /^[0-9]+$/.test(itemId)) {
					attachmentId = itemId;
				}
			}
		}

		results.push({
			id: attachmentId,
			type,
			url,
			preview_url: previewUrl,
			remote_url: remoteUrl,
			preview_remote_url: null,
			text_url: null,
			meta,
			description,
			blurhash,
		});

		index++;
	}

	return results;
};
