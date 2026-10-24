import type { APObject } from '../apex/types.js';
import { apex } from '../apex.js';
import { escapeFirestoreKey, toFirestoreKey, unescapeFirestoreKey } from '../firebase.js';
import { localFeaturedIri, localUsernameOf } from '../localActor.js';
import { UserInfos } from '../schema.js';
import { getObjects } from '../store/objects.js';
import { isAPNote, toIdArray } from '../utils.js';

// 自分のピン留め投稿を `featured` コレクションとして組み立てる (→ ADR-0160)。
// 未認証・外部からのアクセス時は公開・非収載 (apex.isPublic) の Note のみを含め、非公開 (followers-only) は除外する。
// 認証済みの本人アクセス時は非公開も含める。
export const getFeaturedCollection = async (
	actor: APObject,
	authorized = false,
): Promise<APObject> => {
	const actorIri = String(actor.id);
	const actorKey = escapeFirestoreKey(actorIri);
	const username = localUsernameOf(actorIri) ?? String(actor.preferredUsername ?? '');
	const featuredIri = localFeaturedIri(username);

	const pinsSnap = await UserInfos.doc(actorKey)
		.collection('pins')
		.orderBy('createdAt', 'desc')
		.get();

	if (pinsSnap.empty) {
		return {
			id: featuredIri,
			type: 'OrderedCollection',
			totalItems: 0,
			orderedItems: [],
		};
	}

	const noteIris = pinsSnap.docs.map((doc) => unescapeFirestoreKey(toFirestoreKey(doc.id)));
	const noteObjects = await getObjects(noteIris, true);
	const noteMap = new Map<string, APObject>();
	for (const note of noteObjects) {
		if (isAPNote(note) && typeof note.id === 'string') {
			noteMap.set(note.id, note);
		}
	}
	const notes = noteIris
		.map((iri) => noteMap.get(iri))
		.filter((note): note is APObject => note !== undefined);

	const visibleNotes = authorized ? notes : notes.filter((note) => apex.isPublic(note));
	const orderedItems = visibleNotes.map((note) => {
		const cleanNote = { ...note };
		delete cleanNote._meta;
		return cleanNote;
	});

	return {
		id: featuredIri,
		type: 'OrderedCollection',
		totalItems: orderedItems.length,
		orderedItems,
	};
};

// ピン留め・解除のアクティビティ (Add / Remove) をフォロワーへ配送する (→ ADR-0160)。
// 一時的アクティビティ (AP §3.1) として扱うため outbox (Streams) には保存せず、apex.publishActivity で配送する。
export const publishPinActivity = async (
	actor: APObject,
	note: APObject,
	type: 'Add' | 'Remove',
): Promise<void> => {
	const actorIri = String(actor.id);
	const username = localUsernameOf(actorIri) ?? String(actor.preferredUsername ?? '');
	const featuredIri = localFeaturedIri(username);
	const followersIri = toIdArray(actor.followers)[0];

	const activity: APObject = {
		id: apex.utils.activityIdToIRI(),
		type,
		actor: actorIri,
		target: featuredIri,
		object: note.id,
		to: followersIri ? [followersIri] : [],
		published: new Date().toISOString(),
	};

	if (followersIri) {
		await apex.publishActivity(actor, activity, [followersIri]);
	}
};
