import assert from 'node:assert';
import firebase from 'firebase-admin';
import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { db, escapeFirestoreKey } from './firebase.js';
import { UserInfos } from './schema.js';
import { toIdArray } from './utils.js';

// Check if given two sets are equal
const setEqual = <T>(a: Set<T>, b: Set<T>) => {
	if (a.size !== b.size) {
		return false;
	}
	for (const item of a) {
		if (!b.has(item)) {
			return false;
		}
	}
	return true;
};

export const onStreamWritten = onDocumentWritten('streams/{streamId}', async (event) => {
	const stream = event.data?.after?.data?.();
	// If stream is undefined, it means the document is deleted
	if (stream === undefined) {
		return;
	}
	assert(event.data?.after?.ref !== undefined);

	const batch = db.batch();

	const objects = stream.object ?? [];

	// Denormalize objectTypes

	const oldObjectTypes = new Set<string>(stream._meta?.objectTypes ?? []);
	const newObjectTypes = new Set<string>(
		objects
			.map((object: any) => object.type)
			.filter((objectType: any) => typeof objectType === 'string'),
	);

	if (!setEqual(oldObjectTypes, newObjectTypes)) {
		batch.update(event.data.after.ref, {
			'_meta.objectTypes': Array.from(newObjectTypes),
		});
	}

	// Denormalize objectType

	const oldObjectType = stream._meta?.objectType ?? undefined;
	const newObjectType = objects
		.map((object: any) => object.type)
		.find((objectType: any) => typeof objectType === 'string');

	if (oldObjectType !== newObjectType) {
		batch.update(event.data.after.ref, {
			'_meta.objectType': newObjectType,
		});
	}

	// actor/object は IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうるため、
	// findActivityByCollectionAndActorId/ObjectId (→ ADR-0020) が array-contains で
	// 引けるよう、常にスカラー ID の配列へ正規化して denormalize する。

	const oldActorIds = new Set<string>(stream._meta?.actorIds ?? []);
	const newActorIds = new Set<string>(toIdArray(stream.actor));

	if (!setEqual(oldActorIds, newActorIds)) {
		batch.update(event.data.after.ref, {
			'_meta.actorIds': Array.from(newActorIds),
		});
	}

	const oldObjectIds = new Set<string>(stream._meta?.objectIds ?? []);
	const newObjectIds = new Set<string>(toIdArray(stream.object));

	if (!setEqual(oldObjectIds, newObjectIds)) {
		batch.update(event.data.after.ref, {
			'_meta.objectIds': Array.from(newObjectIds),
		});
	}

	await batch.commit();
});

export const onStreamCreated = onDocumentCreated('streams/{streamId}', async (event) => {
	const stream = event.data?.data?.();
	// If stream is undefined, it means the document is deleted
	if (stream === undefined) {
		return;
	}
	assert(event.data?.ref !== undefined);

	const batch = db.batch();

	const objects = stream.object ?? [];
	// actor/object は IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうるため、
	// escapeFirestoreKey に渡す前に toIdArray でスカラー ID に正規化する(→ ADR-0020)。
	const actorId = toIdArray(stream.actor)[0];

	// Denormalize userInfos.statuses_count
	const isNote = objects.some((object: any) => object.type === 'Note');
	if (isNote && actorId !== undefined) {
		batch.update(UserInfos.doc(escapeFirestoreKey(actorId)), {
			statuses_count: firebase.firestore.FieldValue.increment(1),
		});
	}

	// Denormalize userInfos.followers_count
	if (stream.type === 'Follow') {
		for (const objectId of toIdArray(stream.object)) {
			batch.update(UserInfos.doc(escapeFirestoreKey(objectId)), {
				followers_count: firebase.firestore.FieldValue.increment(1),
			});
		}
	}

	if (stream.type === 'Undo') {
		for (const object of objects) {
			if (object.type === 'Follow') {
				for (const followObjectId of toIdArray(object.object)) {
					batch.update(UserInfos.doc(escapeFirestoreKey(followObjectId)), {
						followers_count: firebase.firestore.FieldValue.increment(-1),
					});
				}
			}
		}
	}

	await batch.commit();
});
