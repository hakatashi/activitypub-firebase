import type { APActor } from 'activitypub-types';
import { apex } from '../apex.js';
import type { APObject } from '../apex/index.js';
import { db, escapeFirestoreKey } from '../firebase.js';
import { forgetReactionActivity } from '../projections/reactions.js';
import { ReactionRelations } from '../schema.js';
import type { ReactionKind } from '../schema.js';
import { toIdArray } from '../utils.js';
import type { NoteObject } from './types.js';

// お気に入り・ブーストは、ローカル actor ごとの射影 (`userInfos/{actor}/favourites|reblogs/{Note}`) から読む
// (→ ADR-0084)。射影はローカル actor の分しかないので、リモートの actor を渡すと空になる。
const relationRefs = (actorId: string, kind: ReactionKind, noteIris: string[]) => {
	const collection = ReactionRelations(escapeFirestoreKey(actorId), kind);
	return noteIris.map((iri) => collection.doc(escapeFirestoreKey(iri)));
};

// noteIris のうち、actor がお気に入り / ブースト済みの Note IRI の集合を返す。
export const getReactedNoteIris = async (
	actorId: string,
	kind: ReactionKind,
	noteIris: string[],
): Promise<Set<string>> => {
	if (noteIris.length === 0) {
		return new Set();
	}
	const docs = await db.getAll(...relationRefs(actorId, kind, noteIris));
	return new Set(docs.flatMap((doc) => (doc.exists ? [doc.get('object') as string] : [])));
};

// actor が noteIri に送った、生きている Like / Announce の IRI の一覧を返す。
export const getReactionActivityIris = async (
	actorId: string,
	kind: ReactionKind,
	noteIri: string,
): Promise<string[]> => {
	const [ref] = relationRefs(actorId, kind, [noteIri]);
	return ref === undefined ? [] : ((await ref.get()).data()?.activityIris ?? []);
};

// actor が送った 1 件の Like / Announce アクティビティを Undo する。
// Undo を outbox に積み、元のアクティビティを Store 経由で消す (射影も同じトランザクションで外れる → ADR-0084)。
export const undoReactionActivity = async (
	actor: APObject & APActor,
	activity: APObject,
	kind: ReactionKind,
) => {
	const actorId = actor.id;
	const undo =
		kind === 'favourites'
			? await apex.buildActivity('Undo', actorId, toIdArray(activity.to), {
					object: activity,
				})
			: await apex.buildActivity('Undo', actorId, toIdArray(activity.to), {
					cc: toIdArray(activity.cc),
					object: activity,
				});
	await apex.addToOutbox(actor, undo);
	await apex.store.removeActivity(activity, actorId);
};

// actor が note に送った Like / Announce をすべて Undo する。
// streams に元のアクティビティがない IRI は、射影から外すだけにする。
export const undoReactions = async (
	actor: APObject & APActor,
	note: NoteObject,
	kind: ReactionKind,
) => {
	const actorId = actor.id;
	for (const activityIri of await getReactionActivityIris(actorId, kind, note.id)) {
		const activity = await apex.store.getActivity(activityIri);
		if (activity === undefined) {
			await forgetReactionActivity(kind, note.id, activityIri);
			continue;
		}
		await undoReactionActivity(actor, activity, kind);
	}
};
