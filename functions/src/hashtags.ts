import { toArray, toStringValue, toTypeArray } from './utils.js';

// ハッシュタグ名の正規化 (→ ADR-0103)。Mastodon の HashtagNormalizer に寄せ、NFKC で全角を半角に寄せてから
// 先頭の `#` を除き、小文字化して使えない文字を除く。ASCII folding は行わない。
// Mastodon の Tag::HASHTAG_INVALID_CHARS_RE (`[^[:alnum:]็-๎_·・‌]`) に相当する。
const HASHTAG_INVALID_CHARS = /[^\p{L}\p{M}\p{Nd}็-๎_·・‌]/gu;

export const normalizeHashtag = (name: string): string | undefined => {
	const normalized = name
		.normalize('NFKC')
		.replace(/^#/u, '')
		.toLowerCase()
		.replace(HASHTAG_INVALID_CHARS, '');
	return normalized.length === 0 ? undefined : normalized;
};

// 表示用のタグ名。正規化はせず、先頭の `#` と使えない文字だけを除く (Mastodon の display_name と同じ)。
export const toHashtagDisplayName = (name: string): string | undefined => {
	const displayName = name.replace(/^[#＃]/u, '').replace(HASHTAG_INVALID_CHARS, '');
	return displayName.length === 0 ? undefined : displayName;
};

// object の `tag` にある `Hashtag` の正規化したタグ名 (重複なし)。
export const getObjectHashtags = (object: { tag?: unknown }): string[] => {
	const names = toArray<unknown>(object.tag).flatMap((tag) => {
		if (typeof tag !== 'object' || tag === null || !('type' in tag) || !('name' in tag)) {
			return [];
		}
		if (!toTypeArray(tag.type).includes('Hashtag')) {
			return [];
		}
		const name = toStringValue(tag.name);
		const normalized = name === undefined ? undefined : normalizeHashtag(name);
		return normalized === undefined ? [] : [normalized];
	});
	return [...new Set(names)];
};
