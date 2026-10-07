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

export interface UploadProfileImageParams {
	type: 'avatar' | 'header';
	id: string;
	buffer: Buffer;
	mimeType: string;
	extension: string;
}

export interface UploadedProfileImage {
	url: string;
	storagePath: string;
}

export interface MediaStorageDriver {
	upload(params: UploadMediaParams): Promise<UploadedMedia>;
	uploadPreview(
		params: UploadPreviewParams,
	): Promise<{ previewUrl: string; previewStoragePath: string }>;
	uploadProfileImage?(params: UploadProfileImageParams): Promise<UploadedProfileImage>;
	delete?(paths: string[]): Promise<void>;
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

	async uploadProfileImage({ type, id, buffer, mimeType, extension }) {
		const bucketName = getMediaStorageBucketName();
		const bucket = getStorage(app).bucket(bucketName);
		const folder = type === 'avatar' ? 'accounts/avatars' : 'accounts/headers';
		const storagePath = `${folder}/${id}.${extension}`;

		const file = bucket.file(storagePath);
		await file.save(buffer, {
			contentType: mimeType,
			resumable: false,
		});
		await file.makePublic();

		return {
			url: `https://storage.googleapis.com/${bucketName}/${storagePath}`,
			storagePath,
		};
	},

	async delete(paths: string[]) {
		const bucketName = getMediaStorageBucketName();
		const bucket = getStorage(app).bucket(bucketName);
		await Promise.all(
			paths.map(async (storagePath) => {
				if (!storagePath) {
					return;
				}
				try {
					await bucket.file(storagePath).delete({ ignoreNotFound: true });
				} catch {
					// 削除時のエラーは握りつぶす
				}
			}),
		);
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
export const uploadProfileImage = (params: UploadProfileImageParams) => {
	if (!currentMediaStorageDriver.uploadProfileImage) {
		throw new Error('uploadProfileImage is not implemented in current driver');
	}
	return currentMediaStorageDriver.uploadProfileImage(params);
};
export const deleteMediaFiles = (paths: string[]) =>
	currentMediaStorageDriver.delete ? currentMediaStorageDriver.delete(paths) : Promise.resolve();
export const deleteStorageFileByUrl = async (url: string) => {
	const bucketName = getMediaStorageBucketName();
	const prefix = `https://storage.googleapis.com/${bucketName}/`;
	if (url.startsWith(prefix)) {
		const storagePath = url.slice(prefix.length);
		await deleteMediaFiles([storagePath]);
	}
};
