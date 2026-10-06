import type { APNote } from 'activitypub-types';
import type { mastodon } from 'masto';
import {
	guessFollowersIri,
	isNotePublicTimelineEligible,
	isNoteVisibleTo,
	noteToVisibility,
} from '../social/visibility.js';
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
export const noteToCounts = (
	note: APNote,
	meta?: { likesCount?: number; sharesCount?: number },
) => ({
	replies_count: toTotalItems(note.replies) ?? 0,
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
