import type { APObject } from '../../src/apex/index.js';
import firebase from 'firebase-admin';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { MediaAttachments, Objects, Streams } from '../../src/schema.js';
import type { MediaAttachmentRecord } from '../../src/schema.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';
import type { LocalActor } from '../helpers/index.js';

const UID = 'uid-hakatashi';
const OTHER_UID = 'uid-other';

describe('POST /api/v1/statuses with media_ids (Issue #219, ADR-0092)', () => {
	let me: LocalActor;
	let other: LocalActor;

	const post = (body: Record<string, unknown>, token = 'write-token') =>
		request(mastodon).post('/api/v1/statuses').set('Authorization', `Bearer ${token}`).send(body);

	const createMediaRecord = async (
		id: string,
		actorId: string,
		overrides: Partial<MediaAttachmentRecord> = {},
	): Promise<MediaAttachmentRecord> => {
		const nowTimestamp = firebase.firestore.Timestamp.now();
		const record: MediaAttachmentRecord = {
			id,
			actorId,
			type: 'image',
			storagePath: `media_attachments/files/${id}/original.jpeg`,
			previewStoragePath: `media_attachments/files/${id}/small.jpeg`,
			url: `https://storage.googleapis.com/test-bucket/media_attachments/files/${id}/original.jpeg`,
			previewUrl: `https://storage.googleapis.com/test-bucket/media_attachments/files/${id}/small.jpeg`,
			remoteUrl: null,
			textUrl: null,
			mimeType: 'image/jpeg',
			meta: {
				original: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
				small: { width: 512, height: 341, size: '512x341', aspect: 1.501466 },
				focus: { x: 0.25, y: -0.5 },
			},
			description: 'Alt text for image',
			blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
			statusIri: null,
			createdAt: nowTimestamp,
			updatedAt: nowTimestamp,
			...overrides,
		};
		await MediaAttachments.doc(escapeFirestoreKey(id)).set(record);
		return record;
	};

	beforeEach(async () => {
		await resetFirestore();
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(undefined as never);

		me = await createLocalActor('hakatashi', { uid: UID, id: '1' });
		other = await createLocalActor('other', { uid: OTHER_UID, id: '2' });

		await addAccessToken('write-token', 'read write follow', UID);
		await addAccessToken('other-token', 'read write follow', OTHER_UID);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	test('creates a note with media attachment and preserves media ID in status response', async () => {
		const mediaId = '01924294028402948201';
		await createMediaRecord(mediaId, me.id);

		const response = await post({
			status: 'Post with image',
			media_ids: [mediaId],
		});

		expect(response.status).toBe(200);
		const status = response.body;

		// 1. Status media_attachments
		expect(status.media_attachments).toHaveLength(1);
		const attachment = status.media_attachments[0];
		expect(attachment.id).toBe(mediaId);
		expect(attachment.type).toBe('image');
		expect(attachment.url).toBe(
			`https://storage.googleapis.com/test-bucket/media_attachments/files/${mediaId}/original.jpeg`,
		);
		expect(attachment.preview_url).toBe(
			`https://storage.googleapis.com/test-bucket/media_attachments/files/${mediaId}/small.jpeg`,
		);
		expect(attachment.remote_url).toBeNull();
		expect(attachment.description).toBe('Alt text for image');
		expect(attachment.blurhash).toBe('UBL_:y9F~q_3~q%M%M%M%M%M%M%M');
		expect(attachment.meta).toEqual({
			original: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
			small: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
			focus: { x: 0.25, y: -0.5 },
		});

		// 2. Note in Firestore
		const noteDoc = await Objects.doc(escapeFirestoreKey(status.uri)).get();
		expect(noteDoc.exists).toBe(true);
		const note = noteDoc.data()!;
		expect(note.attachment).toEqual([
			{
				type: 'Document',
				mediaType: 'image/jpeg',
				url: `https://storage.googleapis.com/test-bucket/media_attachments/files/${mediaId}/original.jpeg`,
				name: 'Alt text for image',
				blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
				width: 1200,
				height: 800,
				focalPoint: [0.25, -0.5],
				icon: {
					type: 'Image',
					url: `https://storage.googleapis.com/test-bucket/media_attachments/files/${mediaId}/small.jpeg`,
				},
			},
		]);

		// 3. MediaAttachment updated with statusIri
		const updatedMediaDoc = await MediaAttachments.doc(escapeFirestoreKey(mediaId)).get();
		expect(updatedMediaDoc.data()?.statusIri).toBe(status.uri);

		// 4. Outbox activity contains Note with attachment
		const streams = await Streams.where(
			'_meta.collection',
			'array-contains',
			`${me.id}/outbox`,
		).get();
		const createActivity = streams.docs
			.map((d) => d.data())
			.find((a) => (a.object as APObject[])?.[0]?.id === status.uri);
		expect(createActivity).toBeDefined();
		const activityObject = (createActivity!.object as APObject[])[0]!;
		expect(activityObject.attachment).toBeDefined();

		// 5. Verify apex.toJSONLD retains toot extension terms (blurhash, focalPoint)
		const jsonld = await apex.toJSONLD<Record<string, unknown>>(createActivity!);
		const compactedObject = jsonld.object as Record<string, unknown>;
		const compactedAttachment = (
			Array.isArray(compactedObject.attachment)
				? compactedObject.attachment[0]
				: compactedObject.attachment
		) as Record<string, unknown>;
		expect(compactedAttachment.blurhash).toBe('UBL_:y9F~q_3~q%M%M%M%M%M%M%M');
		expect(compactedAttachment.focalPoint).toEqual([0.25, -0.5]);

		// 6. Subsequent edit via PUT /api/v1/media/:id is rejected
		const putResponse = await request(mastodon)
			.put(`/api/v1/media/${mediaId}`)
			.set('Authorization', 'Bearer write-token')
			.send({ description: 'New description' });
		expect(putResponse.status).toBe(422);
	});

	test('allows posting with media when status text is empty', async () => {
		const mediaId = '01924294028402948202';
		await createMediaRecord(mediaId, me.id);

		const response = await post({
			status: '',
			media_ids: [mediaId],
		});

		expect(response.status).toBe(200);
		expect(response.body.content).toBe('');
		expect(response.body.media_attachments).toHaveLength(1);
		expect(response.body.media_attachments[0].id).toBe(mediaId);
	});

	test('preserves order of multiple media attachments up to limit of 4', async () => {
		const ids = [
			'01924294028402948211',
			'01924294028402948212',
			'01924294028402948213',
			'01924294028402948214',
		];
		for (const id of ids) {
			await createMediaRecord(id, me.id);
		}

		const response = await post({
			status: 'Four photos',
			media_ids: ids,
		});

		expect(response.status).toBe(200);
		expect(response.body.media_attachments).toHaveLength(4);
		expect(response.body.media_attachments.map((m: { id: string }) => m.id)).toEqual(ids);
	});

	test('rejects when more than 4 media attachments are provided', async () => {
		const ids = [
			'01924294028402948221',
			'01924294028402948222',
			'01924294028402948223',
			'01924294028402948224',
			'01924294028402948225',
		];
		const response = await post({
			status: 'Too many photos',
			media_ids: ids,
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain('Cannot attach more than 4 files');
	});

	test('rejects duplicate media IDs with 422', async () => {
		const mediaId = '01924294028402948231';
		await createMediaRecord(mediaId, me.id);

		const response = await post({
			status: 'Duplicate media',
			media_ids: [mediaId, mediaId],
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain('Media not found or already attached to another post');
	});

	test('rejects nonexistent media ID with 422', async () => {
		const response = await post({
			status: 'Nonexistent',
			media_ids: ['nonexistent-media-id'],
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain('Media not found or already attached to another post');
	});

	test('rejects media owned by another user with 422', async () => {
		const mediaId = '01924294028402948241';
		await createMediaRecord(mediaId, other.id);

		const response = await post({
			status: 'Other user media',
			media_ids: [mediaId],
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain('Media not found or already attached to another post');
	});

	test('rejects media already attached to another status with 422', async () => {
		const mediaId = '01924294028402948251';
		await createMediaRecord(mediaId, me.id, {
			statusIri: 'https://example.com/o/already-attached-status',
		});

		const response = await post({
			status: 'Already attached',
			media_ids: [mediaId],
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain('Media not found or already attached to another post');
	});

	test('rejects when both status text and media_ids are empty', async () => {
		const response = await post({
			status: '   ',
			media_ids: [],
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain("Text can't be blank");
	});
});
