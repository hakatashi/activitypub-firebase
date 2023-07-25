import assert from 'assert';
import firebase from 'firebase-admin';
import {onDocumentWritten, onDocumentCreated} from 'firebase-functions/v2/firestore';
import {db, escapeFirestoreKey} from './firebase.js';
import {UserInfos} from './schema.js';

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

	// eslint-disable-next-line private-props/no-use-outside, no-underscore-dangle
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

	// eslint-disable-next-line private-props/no-use-outside, no-underscore-dangle
	const oldObjectType = stream._meta?.objectType ?? undefined;
	const newObjectType =
		objects
			.map((object: any) => object.type)
			.find((objectType: any) => typeof objectType === 'string');

	if (oldObjectType !== newObjectType) {
		batch.update(event.data.after.ref, {
			'_meta.objectType': newObjectType,
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
	const actorId = stream.actor[0];

	// Denormalize userInfos.statuses_count
	const isNote = objects.some((object: any) => object.type === 'Note');
	if (isNote) {
		batch.update(UserInfos.doc(escapeFirestoreKey(actorId)), {
			statuses_count: firebase.firestore.FieldValue.increment(1),
		});
	}

	await batch.commit();
});
