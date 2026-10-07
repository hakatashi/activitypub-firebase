import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { escapeFirestoreKey } from './firebase.js';
import { MediaAttachments } from './schema.js';
import { deleteMediaFiles } from './storage/media.js';

// 24時間 (1日)
export const DEFAULT_UNATTACHED_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CleanUnattachedMediaOptions {
	now?: Date;
	maxAgeMs?: number;
}

// 添付されないまま一定時間経ったメディアを Storage と Firestore から削除する (→ ADR-0092)。
export const cleanUnattachedMedia = async (options: CleanUnattachedMediaOptions = {}) => {
	const now = options.now ?? new Date();
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_UNATTACHED_MEDIA_MAX_AGE_MS;
	const threshold = firebase.firestore.Timestamp.fromDate(new Date(now.getTime() - maxAgeMs));

	const snapshot = await MediaAttachments.where('statusIri', '==', null)
		.where('createdAt', '<', threshold)
		.get();

	if (snapshot.empty) {
		return 0;
	}

	let deletedCount = 0;
	for (const doc of snapshot.docs) {
		const record = doc.data();
		try {
			await deleteMediaFiles([record.storagePath, record.previewStoragePath]);
			await MediaAttachments.doc(escapeFirestoreKey(record.id)).delete();
			deletedCount++;
		} catch (err: unknown) {
			logger.error(`Failed to clean up unattached media ${record.id}:`, err);
		}
	}

	logger.info(`Cleaned up ${deletedCount} unattached media attachments`);
	return deletedCount;
};

export const cleanupMediaTask = onSchedule(
	{
		schedule: 'every 24 hours',
		timeZone: 'Asia/Tokyo',
		retryCount: 1,
	},
	async () => {
		await cleanUnattachedMedia();
	},
);
