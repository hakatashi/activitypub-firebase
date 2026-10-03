import type { APNote } from 'activitypub-types';
import type { mastodon } from 'masto';
import type { CamelToSnake } from '../utils.js';
import { toArray, toIdArray, toStringValue } from '../utils.js';

// Note の実データから Mastodon の Status エンティティの属性を導出する純粋関数群 (→ ADR-0060)。
// Firestore には触らない。解決に外部参照が要るもの (リプライ先の ID など) は呼び出し側が渡す。

const PUBLIC_ADDRESSES = new Set([
	'as:Public',
	'Public',
	'https://www.w3.org/ns/activitystreams#Public',
]);

const isPublicAddress = (iri: string) => PUBLIC_ADDRESSES.has(iri);

// followers コレクションの IRI が分からないとき、Mastodon / このプロジェクトの慣習
// (`{actor}/followers`) で推定する。
export const guessFollowersIri = (note: APNote) => {
	const attributedTo = toIdArray(note.attributedTo)[0];
	return attributedTo === undefined ? undefined : `${attributedTo}/followers`;
};

// `to` / `cc` から可視性を判定する。タイムラインの絞り込みからも再利用する。
//   as:Public が to にある → public / cc にある → unlisted /
//   followers のみ → private / それ以外 (個別 actor のみ) → direct
export const noteToVisibility = (
	note: APNote,
	followersIri: string | undefined = guessFollowersIri(note),
): mastodon.v1.StatusVisibility => {
	const to = toIdArray(note.to);
	const cc = toIdArray(note.cc);
	if (to.some(isPublicAddress)) {
		return 'public';
	}
	if (cc.some(isPublicAddress)) {
		return 'unlisted';
	}
	if (followersIri !== undefined && [...to, ...cc].includes(followersIri)) {
		return 'private';
	}
	return 'direct';
};

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

// viewer (ローカル actor の IRI。未認証なら undefined) が note を閲覧できるか。
// `viewerFollowing` は viewer がフォロー中の actor IRI の集合。
// Status エンティティの `visibility` と同じ noteToVisibility を使い、判定を1箇所に集約する。
export const isNoteVisibleTo = (
	note: APNote,
	viewer: string | undefined,
	viewerFollowing: ReadonlySet<string> = new Set(),
): boolean => {
	const visibility = noteToVisibility(note);
	if (visibility === 'public' || visibility === 'unlisted') {
		return true;
	}
	if (viewer === undefined) {
		return false;
	}
	const author = toIdArray(note.attributedTo)[0];
	if (author === viewer) {
		return true;
	}
	if (visibility === 'private' && author !== undefined && viewerFollowing.has(author)) {
		return true;
	}
	// direct (および private で followers 経由でない場合) は宛先に明示されているときだけ。
	return [...toIdArray(note.to), ...toIdArray(note.cc)].includes(viewer);
};

// 公開タイムラインに載せるのは public のみ (unlisted は載せない)。
export const isNotePublicTimelineEligible = (note: APNote): boolean =>
	noteToVisibility(note) === 'public';
