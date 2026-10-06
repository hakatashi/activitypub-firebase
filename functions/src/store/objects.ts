// `objects` に対するアプリ独自のクエリ。apex の Store 契約には含まれない。
import type { APObject } from '../apex/index.js';
import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { chunk } from 'lodash-es';
import { escapeFirestoreKey } from '../firebase.js';
import { Objects } from '../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from './limits.js';

export const getObjects = async (ids: string[], includeMeta = false): Promise<APObject[]> => {
	logger.info({
		type: 'getObjects',
		ids,
		includeMeta,
	});

	if (ids.length === 0) {
		return [];
	}

	const idChunks = chunk(ids.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT);
	const objectDocsChunks = await Promise.all(
		idChunks.map((idChunk) =>
			Objects.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
		),
	);

	return objectDocsChunks.flatMap((objectDocs) =>
		objectDocs.docs.map((doc) => {
			const object = doc.data();
			if (includeMeta !== true) {
				delete object._meta;
			}
			return object;
		}),
	);
};
