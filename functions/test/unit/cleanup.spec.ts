import firebase from 'firebase-admin';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanUnattachedMedia } from '../../src/cleanup.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { MediaAttachments } from '../../src/schema.js';
import type { MediaAttachmentRecord } from '../../src/schema.js';
import { resetMediaStorageDriver, setMediaStorageDriver } from '../../src/storage/media.js';

describe('cleanUnattachedMedia (ADR-0092)', () => {
	const deletedPaths: string[] = [];

	beforeEach(async () => {
		deletedPaths.length = 0;
		setMediaStorageDriver({
			upload: vi.fn(),
			uploadPreview: vi.fn(),
			delete: (paths: string[]) => {
				deletedPaths.push(...paths);
				return Promise.resolve();
			},
		});

		// Clean up Firestore collection
		const docs = await MediaAttachments.get();
		await Promise.all(docs.docs.map((doc) => doc.ref.delete()));
	});

	afterEach(() => {
		resetMediaStorageDriver();
	});

	test('deletes unattached media created over 24 hours ago', async () => {
		const now = new Date('2026-10-07T12:00:00.000Z');
		const oldTime = firebase.firestore.Timestamp.fromDate(
			new Date('2026-10-06T10:00:00.000Z'), // 26 hours ago
		);
		const recentTime = firebase.firestore.Timestamp.fromDate(
			new Date('2026-10-07T11:00:00.000Z'), // 1 hour ago
		);

		// 1. Old unattached (should be deleted)
		const oldUnattached: MediaAttachmentRecord = {
			id: 'old-unattached-1',
			actorId: 'https://example.com/u/hakatashi',
			type: 'image',
			storagePath: 'media_attachments/files/old-unattached-1/original.jpg',
			previewStoragePath: 'media_attachments/files/old-unattached-1/small.jpg',
			url: 'https://storage.googleapis.com/bucket/original.jpg',
			previewUrl: 'https://storage.googleapis.com/bucket/small.jpg',
			remoteUrl: null,
			textUrl: null,
			mimeType: 'image/jpeg',
			meta: {},
			description: '',
			blurhash: '...',
			statusIri: null,
			createdAt: oldTime,
			updatedAt: oldTime,
		};

		// 2. Old attached (should NOT be deleted)
		const oldAttached: MediaAttachmentRecord = {
			...oldUnattached,
			id: 'old-attached-2',
			storagePath: 'media_attachments/files/old-attached-2/original.jpg',
			previewStoragePath: 'media_attachments/files/old-attached-2/small.jpg',
			statusIri: 'https://example.com/o/status-1',
		};

		// 3. Recent unattached (should NOT be deleted)
		const recentUnattached: MediaAttachmentRecord = {
			...oldUnattached,
			id: 'recent-unattached-3',
			storagePath: 'media_attachments/files/recent-unattached-3/original.jpg',
			previewStoragePath: 'media_attachments/files/recent-unattached-3/small.jpg',
			createdAt: recentTime,
			updatedAt: recentTime,
		};

		await Promise.all([
			MediaAttachments.doc(escapeFirestoreKey(oldUnattached.id)).set(oldUnattached),
			MediaAttachments.doc(escapeFirestoreKey(oldAttached.id)).set(oldAttached),
			MediaAttachments.doc(escapeFirestoreKey(recentUnattached.id)).set(recentUnattached),
		]);

		const deletedCount = await cleanUnattachedMedia({ now });
		expect(deletedCount).toBe(1);

		// Storage files deleted
		expect(deletedPaths).toEqual([
			'media_attachments/files/old-unattached-1/original.jpg',
			'media_attachments/files/old-unattached-1/small.jpg',
		]);

		// Firestore record deleted
		const oldDoc = await MediaAttachments.doc(escapeFirestoreKey(oldUnattached.id)).get();
		expect(oldDoc.exists).toBe(false);

		// Other records kept
		const attachedDoc = await MediaAttachments.doc(escapeFirestoreKey(oldAttached.id)).get();
		expect(attachedDoc.exists).toBe(true);

		const recentDoc = await MediaAttachments.doc(escapeFirestoreKey(recentUnattached.id)).get();
		expect(recentDoc.exists).toBe(true);
	});
});
