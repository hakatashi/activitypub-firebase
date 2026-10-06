import type { APNote } from 'activitypub-types';
import { toIdArray } from '../utils.js';

export type NoteVisibility = 'public' | 'unlisted' | 'private' | 'direct';

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
): NoteVisibility => {
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
