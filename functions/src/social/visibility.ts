import type { HasAddressing } from '../addressing.js';
import { getActorOrAuthor, getFields, noteToVisibility } from '../addressing.js';
import { toIdArray } from '../utils.js';

export type { HasAddressing, NoteVisibility } from '../addressing.js';
export { getActorOrAuthor, guessFollowersIri, noteToVisibility } from '../addressing.js';

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

// 公開タイムラインに載せるのは public のみ (unlisted は載せない)。
export const isNotePublicTimelineEligible = (objectOrActivity: HasAddressing): boolean =>
	noteToVisibility(objectOrActivity) === 'public';
