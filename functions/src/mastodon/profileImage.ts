import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { UnprocessableError } from './http/errors.js';
import { IMAGE_MATRIX_LIMIT } from './mediaProcessing.js';

// サーバーレス環境でのメモリ滞留とスレッドプールによるメモリ膨張を防ぐ (→ ADR-0093)。
sharp.cache(false);
sharp.concurrency(1);

export const AVATAR_SIZE = 400;
export const HEADER_MAX_WIDTH = 1500;
export const HEADER_MAX_HEIGHT = 500;

export interface ProcessedProfileImage {
	buffer: Buffer;
	mimeType: string;
	extension: string;
	width: number;
	height: number;
}

const formatToMimeType: Record<string, string> = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/png', // GIF は静止画化して PNG で保存
	webp: 'image/webp',
};

const formatToExtension: Record<string, string> = {
	jpeg: 'jpeg',
	jpg: 'jpeg',
	png: 'png',
	gif: 'png',
	webp: 'webp',
};

export const processProfileImage = async (
	inputBuffer: Buffer,
	type: 'avatar' | 'header',
): Promise<ProcessedProfileImage> => {
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

	// GIF の場合は最初の1フレームを取り出して静止画化する (→ ADR-0094)。
	let pipeline = sharp(inputBuffer, { pages: 1 }).rotate();

	if (type === 'avatar') {
		// アバターは 400x400 の中央正方形クロップ
		pipeline = pipeline.resize(AVATAR_SIZE, AVATAR_SIZE, {
			fit: 'cover',
			position: 'center',
		});
	} else {
		// ヘッダーは 1500x500 以内にアスペクト比維持で縮小
		pipeline = pipeline.resize(HEADER_MAX_WIDTH, HEADER_MAX_HEIGHT, {
			fit: 'inside',
			withoutEnlargement: true,
		});
	}

	if (format === 'gif') {
		pipeline = pipeline.png();
	}

	const { data: buffer, info } = await pipeline.toBuffer({ resolveWithObject: true });

	return {
		buffer,
		mimeType,
		extension,
		width: info.width,
		height: info.height,
	};
};
