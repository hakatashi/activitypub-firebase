import type { APNote } from 'activitypub-types';
import type { APObject } from './apex/types.js';
import { toIdArray } from './utils.js';

// Note / Activity の宛先 (`to` / `cc`) から公開範囲を判定する純粋関数。`social/` だけでなく、
// `social/` を import できない Store や射影 (→ ADR-0080、ADR-0082) からも使うため、ここに置く。

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

export const getFields = (objectOrActivity: HasAddressing): AddressingFields =>
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
