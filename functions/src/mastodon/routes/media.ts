import express from 'express';
import firebase from 'firebase-admin';
import sharp from 'sharp';
import { escapeFirestoreKey } from '../../firebase.js';
import { assignMediaMastodonId } from '../../mastodonId.js';
import { MediaAttachments } from '../../schema.js';
import type { MediaAttachmentRecord } from '../../schema.js';
import { uploadMedia, uploadPreview } from '../../storage/media.js';
import { authRequired, getAuthActorId, scopeRequired } from '../http/auth.js';
import { NotFoundError, UnprocessableError } from '../http/errors.js';
import { parseMultipart } from '../http/multipart.js';
import { MAX_THUMBNAIL_DIMENSION, parseFocus, processImage } from '../mediaProcessing.js';
import { toMediaAttachmentEntity } from '../presenters/media.js';

const router = express.Router();

const handleUploadMedia = async (req: express.Request, res: express.Response) => {
	const actorId = getAuthActorId(res);
	const { files, fields } = await parseMultipart(req);
	const file = files.file;
	if (!file) {
		throw new UnprocessableError('Validation failed: File must be present');
	}

	const processed = await processImage(file.buffer, files.thumbnail?.buffer, fields.focus);
	const id = await assignMediaMastodonId();

	const uploaded = await uploadMedia({
		id,
		originalBuffer: processed.originalBuffer,
		previewBuffer: processed.previewBuffer,
		originalMimeType: processed.mimeType,
		previewMimeType: processed.previewMimeType,
		extension: processed.extension,
	});

	const nowTimestamp = firebase.firestore.Timestamp.now();

	const record: MediaAttachmentRecord = {
		id,
		actorId,
		type: 'image',
		storagePath: uploaded.storagePath,
		previewStoragePath: uploaded.previewStoragePath,
		url: uploaded.url,
		previewUrl: uploaded.previewUrl,
		remoteUrl: null,
		textUrl: null,
		mimeType: processed.mimeType,
		meta: processed.meta,
		description: fields.description ?? '',
		blurhash: processed.blurhash,
		statusIri: null,
		createdAt: nowTimestamp,
		updatedAt: nowTimestamp,
	};

	await MediaAttachments.doc(escapeFirestoreKey(id)).set(record);

	res.status(200).json(toMediaAttachmentEntity(record));
};

// POST /api/v2/media
router.post('/v2/media', authRequired, scopeRequired('write:media'), handleUploadMedia);

// POST /api/v1/media (v2 と同一処理で 200 を返す)
router.post('/v1/media', authRequired, scopeRequired('write:media'), handleUploadMedia);

// GET /api/v1/media/:id
router.get('/v1/media/:id', authRequired, scopeRequired('write:media'), async (req, res) => {
	const actorId = getAuthActorId(res);
	const id = req.params.id;
	if (typeof id !== 'string') {
		throw new NotFoundError();
	}

	const doc = await MediaAttachments.doc(escapeFirestoreKey(id)).get();
	if (!doc.exists) {
		throw new NotFoundError();
	}

	const record = doc.data()!;
	if (record.actorId !== actorId) {
		throw new NotFoundError();
	}

	res.status(200).json(toMediaAttachmentEntity(record));
});

// PUT /api/v1/media/:id
router.put('/v1/media/:id', authRequired, scopeRequired('write:media'), async (req, res) => {
	const actorId = getAuthActorId(res);
	const id = req.params.id;
	if (typeof id !== 'string') {
		throw new NotFoundError();
	}

	const docRef = MediaAttachments.doc(escapeFirestoreKey(id));
	const doc = await docRef.get();
	if (!doc.exists) {
		throw new NotFoundError();
	}

	const record = doc.data()!;
	if (record.actorId !== actorId) {
		throw new NotFoundError();
	}

	if (record.statusIri !== null) {
		throw new UnprocessableError('Media attachment has already been attached to a status');
	}

	let description: string | undefined;
	let focus: unknown;
	let thumbnailBuffer: Buffer | undefined;

	const contentType = req.headers['content-type']?.toLowerCase() ?? '';
	if (contentType.includes('multipart/form-data')) {
		const parsed = await parseMultipart(req);
		description = parsed.fields.description;
		focus = parsed.fields.focus;
		thumbnailBuffer = parsed.files.thumbnail?.buffer;
	} else if (typeof req.body === 'object' && req.body !== null) {
		description = typeof req.body.description === 'string' ? req.body.description : undefined;
		focus = req.body.focus;
	}

	const updates: Partial<MediaAttachmentRecord> = {
		updatedAt: firebase.firestore.Timestamp.now(),
	};

	if (description !== undefined) {
		updates.description = description;
	}

	let updatedMeta = { ...record.meta };
	const parsedFocus = parseFocus(focus);
	if (parsedFocus !== undefined) {
		updatedMeta.focus = parsedFocus;
		updates.meta = updatedMeta;
	}

	if (thumbnailBuffer) {
		const thumbPipeline = sharp(thumbnailBuffer)
			.rotate()
			.resize(MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION, {
				fit: 'inside',
				withoutEnlargement: true,
			});
		const thumbRes = await thumbPipeline.toBuffer({ resolveWithObject: true });
		const previewMimeType = thumbRes.info.format === 'png' ? 'image/png' : 'image/jpeg';
		const extension = thumbRes.info.format === 'png' ? 'png' : 'jpeg';

		const uploaded = await uploadPreview({
			id: record.id,
			previewBuffer: thumbRes.data,
			previewMimeType,
			extension,
		});

		updates.previewUrl = uploaded.previewUrl;
		updates.previewStoragePath = uploaded.previewStoragePath;
		updatedMeta = {
			...updatedMeta,
			small: {
				width: thumbRes.info.width,
				height: thumbRes.info.height,
				size: `${thumbRes.info.width}x${thumbRes.info.height}`,
				aspect: thumbRes.info.width / thumbRes.info.height,
			},
		};
		updates.meta = updatedMeta;
	}

	const updatedRecord: MediaAttachmentRecord = {
		...record,
		...updates,
	};

	await docRef.set(updatedRecord);

	res.status(200).json(toMediaAttachmentEntity(updatedRecord));
});

export default router;
