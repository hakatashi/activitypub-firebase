import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { UnprocessableError } from '../../../src/mastodon/http/errors.js';
import {
	AVATAR_SIZE,
	HEADER_MAX_HEIGHT,
	HEADER_MAX_WIDTH,
	processProfileImage,
} from '../../../src/mastodon/profileImage.js';

describe('profileImage', () => {
	const createSampleImage = ({
		width = 100,
		height = 80,
		format = 'jpeg',
		withExif = false,
	}: {
		width?: number;
		height?: number;
		format?: 'jpeg' | 'png' | 'webp';
		withExif?: boolean;
	} = {}) => {
		let pipeline = sharp({
			create: {
				width,
				height,
				channels: 3,
				background: { r: 120, g: 150, b: 200 },
			},
		});

		if (withExif) {
			pipeline = pipeline.withMetadata({
				exif: {
					IFD0: {
						Artist: 'Hakatashi',
					},
					GPS: {
						GPSLatitudeRef: 'N',
						GPSLatitude: '35/1 41/1 22/1',
						GPSLongitudeRef: 'E',
						GPSLongitude: '139/1 41/1 30/1',
					},
				} as never,
			});
		}

		if (format === 'png') {
			return pipeline.png().toBuffer();
		}
		if (format === 'webp') {
			return pipeline.webp().toBuffer();
		}
		return pipeline.jpeg().toBuffer();
	};

	test('processes avatar to 400x400 center-cropped image and removes EXIF', async () => {
		const inputWithGps = await createSampleImage({
			width: 600,
			height: 300,
			format: 'jpeg',
			withExif: true,
		});
		const initialMeta = await sharp(inputWithGps).metadata();
		expect(initialMeta.exif).toBeDefined();

		const processed = await processProfileImage(inputWithGps, 'avatar');

		expect(processed.width).toBe(AVATAR_SIZE);
		expect(processed.height).toBe(AVATAR_SIZE);
		expect(processed.mimeType).toBe('image/jpeg');

		const resultMeta = await sharp(processed.buffer).metadata();
		expect(resultMeta.exif).toBeUndefined();
		expect(resultMeta.width).toBe(AVATAR_SIZE);
		expect(resultMeta.height).toBe(AVATAR_SIZE);
	});

	test('processes header to within 1500x500 while preserving aspect ratio and removes EXIF', async () => {
		const inputWithGps = await createSampleImage({
			width: 2000,
			height: 1000,
			format: 'png',
			withExif: true,
		});
		const initialMeta = await sharp(inputWithGps).metadata();
		expect(initialMeta.exif).toBeDefined();

		const processed = await processProfileImage(inputWithGps, 'header');

		expect(processed.width).toBeLessThanOrEqual(HEADER_MAX_WIDTH);
		expect(processed.height).toBeLessThanOrEqual(HEADER_MAX_HEIGHT);
		// 2:1 aspect ratio: 1000x500 fits in 1500x500
		expect(processed.width).toBe(1000);
		expect(processed.height).toBe(500);
		expect(processed.mimeType).toBe('image/png');

		const resultMeta = await sharp(processed.buffer).metadata();
		expect(resultMeta.exif).toBeUndefined();
	});

	test('throws UnprocessableError on non-image or invalid input', async () => {
		const invalidBuffer = Buffer.from('not an image at all');
		await expect(processProfileImage(invalidBuffer, 'avatar')).rejects.toThrow(UnprocessableError);
	});

	test('throws UnprocessableError on unsupported image formats (e.g. tiff)', async () => {
		const tiffBuffer = await sharp({
			create: {
				width: 50,
				height: 50,
				channels: 3,
				background: { r: 255, g: 0, b: 0 },
			},
		})
			.tiff()
			.toBuffer();

		await expect(processProfileImage(tiffBuffer, 'avatar')).rejects.toThrow(UnprocessableError);
	});
});
