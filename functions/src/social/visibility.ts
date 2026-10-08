import type { APNote } from 'activitypub-types';
import type { APObject } from '../apex/types.js';
import { toIdArray } from '../utils.js';

export type NoteVisibility = 'public' | 'unlisted' | 'private' | 'direct';

interface AddressingFields {
	to?: unknown;
	cc?: unknown;
	attributedTo?: unknown;
	actor?: unknown;
}

export type HasAddressing = APObject | APNote | AddressingFields;

const PUBLIC_ADDRESSES = new Set([
	'as:Public',
	'Public',
	'https://www.w3.org/ns/activitystreams#Public',
]);

const isPublicAddress = (iri: string) => PUBLIC_ADDRESSES.has(iri);

const getFields = (objectOrActivity: HasAddressing): AddressingFields =>
	objectOrActivity as AddressingFields;

export const getActorOrAuthor = (objectOrActivity: HasAddressing): string | undefined => {
	const fields = getFields(objectOrActivity);
	return toIdArray(fields.attributedTo)[0] ?? toIdArray(fields.actor)[0];
};

// followers コレクションの IRI が分からないとき、Mastodon / このプロジェクトの慣習
// (`{actor}/followers`) で推定する。Note (attributedTo) と Activity (actor) の両方に対応。
export const guessFollowersIri = (objectOrActivity: HasAddressing) => {
	const author = getActorOrAuthor(objectOrActivity);
	return author === undefined ? undefined : `${author}/followers`;
};

// `to` / `cc` から可視性を判定する。タイムラインの絞り込みからも再利用する。
//   as:Public が to にある → public / cc にある → unlisted /
//   followers のみ → private / それ以外 (個別 actor のみ) → direct
export const noteToVisibility = (
	objectOrActivity: HasAddressing,
	followersIri: string | undefined = guessFollowersIri(objectOrActivity),
): NoteVisibility => {
	const fields = getFields(objectOrActivity);
	const to = toIdArray(fields.to);
	const cc = toIdArray(fields.cc);
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

export const activityToVisibility = noteToVisibility;

// viewer (ローカル actor の IRI。未認証なら undefined) が note / activity を閲覧できるか。
// `viewerFollowing` は viewer がフォロー中の actor IRI の集合。
// Status エンティティの `visibility` と同じ noteToVisibility を使い、判定を1箇所に集約する。
export const isNoteVisibleTo = (
	objectOrActivity: HasAddressing,
	viewer: string | undefined,
	viewerFollowing: ReadonlySet<string> = new Set(),
): boolean => {
	const visibility = noteToVisibility(objectOrActivity);
	if (visibility === 'public' || visibility === 'unlisted') {
		return true;
	}
	if (viewer === undefined) {
		return false;
	}
	const author = getActorOrAuthor(objectOrActivity);
	if (author === viewer) {
		return true;
	}
	if (visibility === 'private' && author !== undefined && viewerFollowing.has(author)) {
		return true;
	}
	const fields = getFields(objectOrActivity);
	// direct (および private で followers 経由でない場合) は宛先に明示されているときだけ。
	return [...toIdArray(fields.to), ...toIdArray(fields.cc)].includes(viewer);
};

export const isActivityVisibleTo = isNoteVisibleTo;

// 公開タイムラインに載せるのは public のみ (unlisted は載せない)。
export const isNotePublicTimelineEligible = (objectOrActivity: HasAddressing): boolean =>
	noteToVisibility(objectOrActivity) === 'public';
