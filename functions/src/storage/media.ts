import { getStorage } from 'firebase-admin/storage';
import { app, projectId } from '../firebase.js';

// Cloud Storage へのメディア保存モジュール (→ ADR-0091)。
// テスト時は `setMediaStorageDriver` で差し替えられる (→ docs/runbooks/local-development.md)。

export interface UploadedMedia {
	url: string;
	previewUrl: string;
	storagePath: string;
	previewStoragePath: string;
}

export interface UploadMediaParams {
	id: string;
	originalBuffer: Buffer;
	previewBuffer: Buffer;
	originalMimeType: string;
	previewMimeType: string;
	extension: string;
}

export interface UploadPreviewParams {
	id: string;
	previewBuffer: Buffer;
	previewMimeType: string;
	extension: string;
}

export interface MediaStorageDriver {
	upload(params: UploadMediaParams): Promise<UploadedMedia>;
	uploadPreview(
		params: UploadPreviewParams,
	): Promise<{ previewUrl: string; previewStoragePath: string }>;
}

export const getMediaStorageBucketName = () => `${projectId}.firebasestorage.app`;

export const defaultMediaStorageDriver: MediaStorageDriver = {
	async upload({
		id,
		originalBuffer,
		previewBuffer,
		originalMimeType,
		previewMimeType,
		extension,
	}) {
		const bucketName = getMediaStorageBucketName();
		const bucket = getStorage(app).bucket(bucketName);
		const storagePath = `media_attachments/files/${id}/original.${extension}`;
		const previewStoragePath = `media_attachments/files/${id}/small.${extension}`;

		const originalFile = bucket.file(storagePath);
		await originalFile.save(originalBuffer, {
			contentType: originalMimeType,
			resumable: false,
		});
		await originalFile.makePublic();

		const previewFile = bucket.file(previewStoragePath);
		await previewFile.save(previewBuffer, {
			contentType: previewMimeType,
			resumable: false,
		});
		await previewFile.makePublic();

		return {
			url: `https://storage.googleapis.com/${bucketName}/${storagePath}`,
			previewUrl: `https://storage.googleapis.com/${bucketName}/${previewStoragePath}`,
			storagePath,
			previewStoragePath,
		};
	},

	async uploadPreview({ id, previewBuffer, previewMimeType, extension }) {
		const bucketName = getMediaStorageBucketName();
		const bucket = getStorage(app).bucket(bucketName);
		const previewStoragePath = `media_attachments/files/${id}/small.${extension}`;

		const previewFile = bucket.file(previewStoragePath);
		await previewFile.save(previewBuffer, {
			contentType: previewMimeType,
			resumable: false,
		});
		await previewFile.makePublic();

		return {
			previewUrl: `https://storage.googleapis.com/${bucketName}/${previewStoragePath}`,
			previewStoragePath,
		};
	},
};

let currentMediaStorageDriver: MediaStorageDriver = defaultMediaStorageDriver;

export const setMediaStorageDriver = (driver: MediaStorageDriver) => {
	currentMediaStorageDriver = driver;
};

export const resetMediaStorageDriver = () => {
	currentMediaStorageDriver = defaultMediaStorageDriver;
};

export const uploadMedia = (params: UploadMediaParams) => currentMediaStorageDriver.upload(params);
export const uploadPreview = (params: UploadPreviewParams) =>
	currentMediaStorageDriver.uploadPreview(params);
