import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mediaUploadApi as mastodon } from '../../src/mastodon/index.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { MediaAttachments } from '../../src/schema.js';
import { resetMediaStorageDriver, setMediaStorageDriver } from '../../src/storage/media.js';
import type { UploadedMedia, UploadMediaParams } from '../../src/storage/media.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID = 'uid-hakatashi';
const OTHER_UID = 'uid-other';

describe('Media API endpoints (Issue #218)', () => {
	let me: LocalActor;
	let uploadedFiles: Map<string, Buffer>;

	const createSampleJpeg = (withGps = true) => {
		let pipeline = sharp({
			create: {
				width: 100,
				height: 100,
				channels: 3,
				background: { r: 100, g: 150, b: 200 },
			},
		});
		if (withGps) {
			pipeline = pipeline.withMetadata({
				exif: {
					IFD0: { Artist: 'TestUser' },
					GPS: {
						GPSLatitudeRef: 'N',
						GPSLatitude: '35/1 41/1 22/1',
					},
				} as never,
			});
		}
		return pipeline.jpeg().toBuffer();
	};

	beforeEach(async () => {
		await resetFirestore();
		uploadedFiles = new Map();

		setMediaStorageDriver({
			upload(params: UploadMediaParams): Promise<UploadedMedia> {
				uploadedFiles.set(`original-${params.id}`, params.originalBuffer);
				uploadedFiles.set(`preview-${params.id}`, params.previewBuffer);
				return Promise.resolve({
					url: `https://storage.googleapis.com/test-bucket/media/${params.id}/original.${params.extension}`,
					previewUrl: `https://storage.googleapis.com/test-bucket/media/${params.id}/small.${params.extension}`,
					storagePath: `media/${params.id}/original.${params.extension}`,
					previewStoragePath: `media/${params.id}/small.${params.extension}`,
				});
			},
			uploadPreview(params) {
				uploadedFiles.set(`preview-${params.id}`, params.previewBuffer);
				return Promise.resolve({
					previewUrl: `https://storage.googleapis.com/test-bucket/media/${params.id}/small.${params.extension}`,
					previewStoragePath: `media/${params.id}/small.${params.extension}`,
				});
			},
		});

		me = await createLocalActor('hakatashi', { uid: UID, id: '1' });
		await createLocalActor('other', { uid: OTHER_UID, id: '2' });

		await addAccessToken('write-token', 'read write follow', UID);
		await addAccessToken('media-token', 'write:media', UID);
		await addAccessToken('read-token', 'read', UID);
		await addAccessToken('other-token', 'write:media', OTHER_UID);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetMediaStorageDriver();
		await resetFirestore();
	});

	describe('POST /api/v2/media', () => {
		test('returns 401 without token', async () => {
			const res = await request(mastodon).post('/api/v2/media');
			expect(res.status).toBe(401);
		});

		test('returns 403 when scope lacks write:media', async () => {
			const res = await request(mastodon)
				.post('/api/v2/media')
				.set('Authorization', 'Bearer read-token');
			expect(res.status).toBe(403);
		});

		test('returns 422 when file is missing', async () => {
			const res = await request(mastodon)
				.post('/api/v2/media')
				.set('Authorization', 'Bearer media-token')
				.field('description', 'A photo');
			expect(res.status).toBe(422);
		});

		test('uploads media, strips EXIF, saves to Firestore and returns MediaAttachment', async () => {
			const imageBuffer = await createSampleJpeg(true);
			const initialMeta = await sharp(imageBuffer).metadata();
			expect(initialMeta.exif).toBeDefined();

			const res = await request(mastodon)
				.post('/api/v2/media')
				.set('Authorization', 'Bearer media-token')
				.attach('file', imageBuffer, 'photo.jpg')
				.field('description', 'A nice sunset')
				.field('focus', '0.2,-0.5');

			expect(res.status).toBe(200);
			const attachment = res.body;
			expect(attachment.id).toMatch(/^\d{20}$/);
			expect(attachment.type).toBe('image');
			expect(attachment.url).toContain(attachment.id);
			expect(attachment.preview_url).toContain(attachment.id);
			expect(attachment.description).toBe('A nice sunset');
			expect(attachment.meta.focus).toEqual({ x: 0.2, y: -0.5 });
			expect(attachment.blurhash.length).toBeGreaterThan(0);

			// Verify in Firestore
			const doc = await MediaAttachments.doc(escapeFirestoreKey(attachment.id)).get();
			expect(doc.exists).toBe(true);
			const record = doc.data()!;
			expect(record.actorId).toBe(me.id);
			expect(record.statusIri).toBeNull();

			// Verify saved image has EXIF stripped
			const savedOriginal = uploadedFiles.get(`original-${attachment.id}`);
			expect(savedOriginal).toBeDefined();
			const originalMeta = await sharp(savedOriginal!).metadata();
			expect(originalMeta.exif).toBeUndefined();
		});
	});

	describe('POST /api/v1/media', () => {
		test('uploads media synchronously and returns 200 with MediaAttachment', async () => {
			const imageBuffer = await createSampleJpeg(false);

			const res = await request(mastodon)
				.post('/api/v1/media')
				.set('Authorization', 'Bearer write-token')
				.attach('file', imageBuffer, 'photo.jpg');

			expect(res.status).toBe(200);
			expect(res.body.id).toMatch(/^\d{20}$/);
			expect(res.body.type).toBe('image');
		});
	});

	describe('GET /api/v1/media/:id', () => {
		test('returns 200 for own media and 404 for other user media or non-existent', async () => {
			const imageBuffer = await createSampleJpeg(false);
			const createRes = await request(mastodon)
				.post('/api/v2/media')
				.set('Authorization', 'Bearer media-token')
				.attach('file', imageBuffer, 'test.jpg');
			const id = createRes.body.id;

			// Own media
			const getRes = await request(mastodon)
				.get(`/api/v1/media/${id}`)
				.set('Authorization', 'Bearer media-token');
			expect(getRes.status).toBe(200);
			expect(getRes.body.id).toBe(id);

			// Other user's media -> 404
			const otherRes = await request(mastodon)
				.get(`/api/v1/media/${id}`)
				.set('Authorization', 'Bearer other-token');
			expect(otherRes.status).toBe(404);

			// Non-existent media -> 404
			const notFoundRes = await request(mastodon)
				.get('/api/v1/media/99999999999999999999')
				.set('Authorization', 'Bearer media-token');
			expect(notFoundRes.status).toBe(404);
		});
	});

	describe('PUT /api/v1/media/:id', () => {
		test('updates description and focus of unattached media', async () => {
			const imageBuffer = await createSampleJpeg(false);
			const createRes = await request(mastodon)
				.post('/api/v2/media')
				.set('Authorization', 'Bearer media-token')
				.attach('file', imageBuffer, 'test.jpg')
				.field('description', 'Initial description');
			const id = createRes.body.id;

			// Update via JSON body
			const putRes = await request(mastodon)
				.put(`/api/v1/media/${id}`)
				.set('Authorization', 'Bearer media-token')
				.send({
					description: 'Updated description',
					focus: '-0.3,0.8',
				});

			expect(putRes.status).toBe(200);
			expect(putRes.body.description).toBe('Updated description');
			expect(putRes.body.meta.focus).toEqual({ x: -0.3, y: 0.8 });

			// Verify in Firestore
			const doc = await MediaAttachments.doc(escapeFirestoreKey(id)).get();
			expect(doc.data()?.description).toBe('Updated description');
			expect(doc.data()?.meta.focus).toEqual({ x: -0.3, y: 0.8 });
		});

		test('returns 404 when updating other user media', async () => {
			const imageBuffer = await createSampleJpeg(false);
			const createRes = await request(mastodon)
				.post('/api/v2/media')
				.set('Authorization', 'Bearer media-token')
				.attach('file', imageBuffer, 'test.jpg');
			const id = createRes.body.id;

			const putRes = await request(mastodon)
				.put(`/api/v1/media/${id}`)
				.set('Authorization', 'Bearer other-token')
				.send({ description: 'Hacked' });

			expect(putRes.status).toBe(404);
		});

		test('returns 422 if media is already attached to a status', async () => {
			const imageBuffer = await createSampleJpeg(false);
			const createRes = await request(mastodon)
				.post('/api/v2/media')
				.set('Authorization', 'Bearer media-token')
				.attach('file', imageBuffer, 'test.jpg');
			const id = createRes.body.id;

			// Mark as attached
			await MediaAttachments.doc(escapeFirestoreKey(id)).update({
				statusIri: 'https://hakatashi.com/activitypub/statuses/123',
			});

			const putRes = await request(mastodon)
				.put(`/api/v1/media/${id}`)
				.set('Authorization', 'Bearer media-token')
				.send({ description: 'Should fail' });

			expect(putRes.status).toBe(422);
		});
	});
});
