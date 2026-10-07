import { encode } from 'blurhash';
import sharp from 'sharp';
import type { Metadata } from 'sharp';
import type { MediaAttachmentMeta } from '../schema.js';
import { UnprocessableError } from './http/errors.js';

// サーバーレス環境でのメモリ滞留とスレッドプールによるメモリ膨張を防ぐ (→ ADR-0093)。
sharp.cache(false);
sharp.concurrency(1);

export const SUPPORTED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export const IMAGE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB (→ ADR-0091)
export const IMAGE_MATRIX_LIMIT = 16_777_216; // 16MP (4096 * 4096)
export const MAX_THUMBNAIL_DIMENSION = 512;

export interface ProcessedMedia {
	originalBuffer: Buffer;
	previewBuffer: Buffer;
	mimeType: string;
	previewMimeType: string;
	extension: string;
	meta: MediaAttachmentMeta;
	blurhash: string;
}

const formatToMimeType: Record<string, string> = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
};

const formatToExtension: Record<string, string> = {
	jpeg: 'jpeg',
	jpg: 'jpeg',
	png: 'png',
	gif: 'gif',
	webp: 'webp',
};

export const parseFocus = (focus: unknown): { x: number; y: number } | undefined => {
	if (typeof focus !== 'string' || focus.trim() === '') {
		return undefined;
	}
	const parts = focus.split(',');
	if (parts.length !== 2) {
		return undefined;
	}
	const [part0, part1] = parts;
	if (part0 === undefined || part1 === undefined) {
		return undefined;
	}
	const x = Number.parseFloat(part0.trim());
	const y = Number.parseFloat(part1.trim());
	if (Number.isNaN(x) || Number.isNaN(y)) {
		return undefined;
	}
	return {
		x: Math.max(-1, Math.min(1, x)),
		y: Math.max(-1, Math.min(1, y)),
	};
};

export const processImage = async (
	inputBuffer: Buffer,
	customThumbnailBuffer?: Buffer,
	focusParam?: unknown,
): Promise<ProcessedMedia> => {
	let metadata: Metadata;
	try {
		metadata = await sharp(inputBuffer).metadata();
	} catch {
		throw new UnprocessableError(
			'Validation failed: File content type is invalid, File is invalid',
		);
	}

	const format = metadata.format;
	if (!format || !formatToMimeType[format]) {
		throw new UnprocessableError(
			'Validation failed: File content type is invalid, File is invalid',
		);
	}

	const width = metadata.width;
	const height = metadata.height;
	if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
		throw new UnprocessableError('Validation failed: File is invalid');
	}

	if (width * height > IMAGE_MATRIX_LIMIT) {
		throw new UnprocessableError('Validation failed: File is too large');
	}

	const mimeType = formatToMimeType[format]!;
	const extension = formatToExtension[format]!;

	// EXIF などのメタデータを除去し、Orientation に従って回転させたオリジナル画像を生成 (→ ADR-0091)。
	// sharp は `.withMetadata()` を呼ばない限り EXIF を除去する。
	let originalPipeline = sharp(inputBuffer, { animated: format === 'gif' });
	if (format !== 'gif') {
		originalPipeline = originalPipeline.rotate();
	}
	const { data: originalBuffer, info: originalInfo } = await originalPipeline.toBuffer({
		resolveWithObject: true,
	});

	// サムネイル (small) の生成
	let previewBuffer: Buffer;
	let previewMimeType: string;
	let previewWidth: number;
	let previewHeight: number;

	if (customThumbnailBuffer) {
		try {
			const thumbPipeline = sharp(customThumbnailBuffer)
				.rotate()
				.resize(MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION, {
					fit: 'inside',
					withoutEnlargement: true,
				});
			const thumbRes = await thumbPipeline.toBuffer({ resolveWithObject: true });
			previewBuffer = thumbRes.data;
			previewWidth = thumbRes.info.width;
			previewHeight = thumbRes.info.height;
			previewMimeType = formatToMimeType[thumbRes.info.format] ?? 'image/jpeg';
		} catch {
			throw new UnprocessableError('Error processing thumbnail for uploaded media');
		}
	} else {
		// GIF の場合は最初のフレームを取り出して静止画としてリサイズ
		const thumbPipeline = sharp(inputBuffer, { pages: 1 })
			.rotate()
			.resize(MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION, {
				fit: 'inside',
				withoutEnlargement: true,
			});
		const thumbRes = await thumbPipeline.toBuffer({ resolveWithObject: true });
		previewBuffer = thumbRes.data;
		previewWidth = thumbRes.info.width;
		previewHeight = thumbRes.info.height;
		previewMimeType = formatToMimeType[thumbRes.info.format] ?? mimeType;
	}

	// Blurhash の計算 (32x32 RGBA)
	let blurhash = '';
	try {
		const rawSample = await sharp(previewBuffer)
			.resize(32, 32, { fit: 'inside' })
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		blurhash = encode(
			new Uint8ClampedArray(rawSample.data),
			rawSample.info.width,
			rawSample.info.height,
			4,
			3,
		);
	} catch {
		// blurhash 計算失敗時は空文字
	}

	const focus = parseFocus(focusParam);

	const meta: MediaAttachmentMeta = {
		original: {
			width: originalInfo.width,
			height: originalInfo.height,
			size: `${originalInfo.width}x${originalInfo.height}`,
			aspect: originalInfo.width / originalInfo.height,
		},
		small: {
			width: previewWidth,
			height: previewHeight,
			size: `${previewWidth}x${previewHeight}`,
			aspect: previewWidth / previewHeight,
		},
		...(focus ? { focus } : {}),
	};

	return {
		originalBuffer,
		previewBuffer,
		mimeType,
		previewMimeType,
		extension,
		meta,
		blurhash,
	};
};
