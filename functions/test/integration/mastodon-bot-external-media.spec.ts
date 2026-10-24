import type { APObject } from '../../src/apex/index.js';
import firebase from 'firebase-admin';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { app } from '../../src/activitypub.js';
import { apex } from '../../src/apex.js';
import { escapeFirestoreKey } from '../../src/firebase.js';
import { mastodonApi as mastodon } from '../../src/mastodon/index.js';
import { MediaAttachments, Objects, Streams } from '../../src/schema.js';
import type { MediaAttachmentRecord } from '../../src/schema.js';
import { createBot } from '../../src/social/bots.js';
import { addAccessToken, createLocalActor, resetFirestore } from '../helpers/index.js';

const adminHeader = { 'x-hakatashi-token': 'test-token' };
const UID = 'uid-hakatashi';

describe('bot external media URLs (Issue #398, ADR-0162)', () => {
	let operatorToken: string;

	const postAsBot = (body: Record<string, unknown>, username = 'weather') =>
		request(mastodon)
			.post('/api/v1/statuses')
			.set('Authorization', `Bearer ${operatorToken}`)
			.set('X-Bot-Account', username)
			.send(body);

	const postAsUser = (body: Record<string, unknown>, token = 'me-token') =>
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
			},
			description: 'Uploaded image',
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
		process.env.HAKATASHI_TOKEN = 'test-token';
		await resetFirestore();
		vi.spyOn(apex.store, 'deliveryEnqueue').mockResolvedValue(true as never);

		await createLocalActor('hakatashi', { uid: UID, id: '1' });
		await addAccessToken('me-token', 'read write follow', UID);
		await createBot({ username: 'weather', followPolicy: { mode: 'open', allowlist: [] } });

		const res = await request(app).post('/activitypub/bots/operator-token').set(adminHeader);
		expect(res.status).toBe(201);
		operatorToken = res.body.accessToken as string;
	});

	afterEach(async () => {
		delete process.env.HAKATASHI_TOKEN;
		vi.restoreAllMocks();
		await resetFirestore();
	});

	test('posts as bot with external media_urls containing full metadata', async () => {
		const response = await postAsBot({
			status: '気象レーダー画像です',
			media_urls: [
				{
					url: 'https://example.com/radar.png',
					description: '雨雲レーダー',
					mime_type: 'image/png',
					width: 1200,
					height: 800,
					blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
				},
			],
		});

		expect(response.status).toBe(200);
		const status = response.body;

		// 1. Status response media_attachments
		expect(status.media_attachments).toHaveLength(1);
		const attachment = status.media_attachments[0];
		expect(attachment.id).toBe(`${status.id}0`);
		expect(attachment.type).toBe('image');
		expect(attachment.url).toBe('https://example.com/radar.png');
		expect(attachment.preview_url).toBe('https://example.com/radar.png');
		expect(attachment.remote_url).toBeNull();
		expect(attachment.description).toBe('雨雲レーダー');
		expect(attachment.blurhash).toBe('UBL_:y9F~q_3~q%M%M%M%M%M%M%M');
		expect(attachment.meta).toEqual({
			original: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
			small: { width: 1200, height: 800, size: '1200x800', aspect: 1.5 },
		});

		// 2. Note in Firestore Objects
		const noteDoc = await Objects.doc(escapeFirestoreKey(status.uri)).get();
		expect(noteDoc.exists).toBe(true);
		const note = noteDoc.data()!;
		expect(note.attachment).toEqual([
			{
				type: 'Document',
				mediaType: 'image/png',
				url: 'https://example.com/radar.png',
				name: '雨雲レーダー',
				blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
				width: 1200,
				height: 800,
				icon: {
					type: 'Image',
					url: 'https://example.com/radar.png',
				},
			},
		]);

		// 3. No document in MediaAttachments collection
		const mediaSnap = await MediaAttachments.get();
		expect(mediaSnap.empty).toBe(true);

		// 4. Outbox activity contains Note with attachment and preserves toot terms
		const streams = await Streams.where(
			'_meta.collection',
			'array-contains',
			`https://activitypub-dev.hakatashi.com/activitypub/u/weather/outbox`,
		).get();
		const createActivity = streams.docs
			.map((d) => d.data())
			.find((a) => (a.object as APObject[])?.[0]?.id === status.uri);
		expect(createActivity).toBeDefined();

		const jsonld = await apex.toJSONLD<Record<string, unknown>>(createActivity!);
		const compactedObject = jsonld.object as Record<string, unknown>;
		const compactedAttachment = (
			Array.isArray(compactedObject.attachment)
				? compactedObject.attachment[0]
				: compactedObject.attachment
		) as Record<string, unknown>;
		expect(compactedAttachment.blurhash).toBe('UBL_:y9F~q_3~q%M%M%M%M%M%M%M');

		// 5. GET /api/v1/statuses/:id returns the same media_attachments
		const getRes = await request(mastodon).get(`/api/v1/statuses/${status.id}`);
		expect(getRes.status).toBe(200);
		expect(getRes.body.media_attachments).toEqual(status.media_attachments);
	});

	test('posts as bot with string array in media_urls', async () => {
		const response = await postAsBot({
			status: 'Satellite view',
			media_urls: ['https://example.com/satellite.webp'],
		});

		expect(response.status).toBe(200);
		const attachment = response.body.media_attachments[0];
		expect(attachment.url).toBe('https://example.com/satellite.webp');
		expect(attachment.type).toBe('image');
		expect(attachment.description).toBeNull();
	});

	test('posts with empty text and media_urls', async () => {
		const response = await postAsBot({
			status: '',
			media_urls: ['https://example.com/radar.png'],
		});

		expect(response.status).toBe(200);
		expect(response.body.media_attachments).toHaveLength(1);
	});

	test('combines uploaded media_ids and external media_urls', async () => {
		const mediaId = '01924294028402948201';
		await createMediaRecord(mediaId, 'https://activitypub-dev.hakatashi.com/activitypub/u/weather');

		const response = await postAsBot({
			status: 'Combined media',
			media_ids: [mediaId],
			media_urls: ['https://example.com/radar.png'],
		});

		expect(response.status).toBe(200);
		expect(response.body.media_attachments).toHaveLength(2);
		expect(response.body.media_attachments[0].id).toBe(mediaId);
		expect(response.body.media_attachments[1].url).toBe('https://example.com/radar.png');

		const updatedMediaDoc = await MediaAttachments.doc(escapeFirestoreKey(mediaId)).get();
		expect(updatedMediaDoc.data()?.statusIri).toBe(response.body.uri);
	});

	test('rejects when total media count exceeds max_media_attachments', async () => {
		const response = await postAsBot({
			status: 'Too many files',
			media_urls: [
				'https://example.com/1.png',
				'https://example.com/2.png',
				'https://example.com/3.png',
				'https://example.com/4.png',
				'https://example.com/5.png',
			],
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain('Cannot attach more than 4 files');
	});

	test('rejects duplicate external URLs', async () => {
		const response = await postAsBot({
			status: 'Duplicate URLs',
			media_urls: ['https://example.com/radar.png', 'https://example.com/radar.png'],
		});

		expect(response.status).toBe(422);
		expect(response.body.error).toContain('Duplicate media URL');
	});

	test('rejects unsafe external URLs', async () => {
		const resHttp = await postAsBot({
			status: 'http test',
			media_urls: ['http://example.com/radar.png'],
		});
		expect(resHttp.status).toBe(422);

		const resLocalhost = await postAsBot({
			status: 'localhost test',
			media_urls: ['https://localhost/radar.png'],
		});
		expect(resLocalhost.status).toBe(422);

		const resLoopback = await postAsBot({
			status: 'loopback test',
			media_urls: ['https://127.0.0.1/radar.png'],
		});
		expect(resLoopback.status).toBe(422);

		const resMetadata = await postAsBot({
			status: 'metadata test',
			media_urls: ['https://169.254.169.254/latest/meta-data'],
		});
		expect(resMetadata.status).toBe(422);

		const resPrivate = await postAsBot({
			status: 'private test',
			media_urls: ['https://10.0.0.1/radar.png'],
		});
		expect(resPrivate.status).toBe(422);
	});

	test('rejects media_urls for non-bot accounts with 403 Forbidden', async () => {
		const response = await postAsUser({
			status: 'User trying to attach external URL',
			media_urls: ['https://example.com/radar.png'],
		});

		expect(response.status).toBe(403);
		expect(response.body.error).toBe('This feature is only available for bot accounts');
	});

	test('allows non-bot accounts when media_urls is empty', async () => {
		const response = await postAsUser({
			status: 'Ordinary post with empty media_urls',
			media_urls: [],
		});

		expect(response.status).toBe(200);
		expect(response.body.account.username).toBe('hakatashi');
	});
});
