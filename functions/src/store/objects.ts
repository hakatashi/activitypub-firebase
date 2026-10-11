// `objects` に対するクエリ。Store クラス (ApexStore) とアプリ側の双方が共有する。
import type { APObject } from '../apex/index.js';
import { logger } from 'firebase-functions/v2';
import { chunk } from 'lodash-es';
import { db, escapeFirestoreKey } from '../firebase.js';
import { Objects } from '../schema.js';

export const getObjects = async (ids: string[], includeMeta = false): Promise<APObject[]> => {
	logger.info({
		type: 'getObjects',
		ids,
		includeMeta,
	});

	if (ids.length === 0) {
		return [];
	}

	const uniqueIds = Array.from(new Set(ids));
	const idChunks = chunk(uniqueIds, 500);
	const docSnapshotsChunks = await Promise.all(
		idChunks.map((chunkIds) =>
			db.getAll(...chunkIds.map((id) => Objects.doc(escapeFirestoreKey(id)))),
		),
	);

	return docSnapshotsChunks.flatMap((docSnapshots) =>
		docSnapshots.flatMap((doc) => {
			if (!doc.exists) {
				return [];
			}
			const object = doc.data() as APObject;
			if (includeMeta !== true) {
				delete object._meta;
			}
			return [object];
		}),
	);
};
