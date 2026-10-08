import { mastodonDomain } from '../../firebase.js';

export interface TagEntity {
	name: string;
	url: string;
	history: [];
	following: boolean;
}

// タグの URL は本文のハッシュタグのリンク (statusContent.ts の formatHashtag) と揃える。
export const hashtagUrl = (name: string) =>
	`https://${mastodonDomain}/tags/${encodeURIComponent(name)}`;

// Tag エンティティ。使用回数 (history) とタグのフォローは扱わない (→ ADR-0103)。
export const toTagEntity = (name: string): TagEntity => ({
	name,
	url: hashtagUrl(name),
	history: [],
	following: false,
});
