import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { UnprocessableError } from '../../../src/mastodon/http/errors.js';
import { parseFocus, processImage } from '../../../src/mastodon/mediaProcessing.js';

describe('mediaProcessing', () => {
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

	test('removes EXIF (especially GPS metadata) from processed images', async () => {
		const inputWithGps = await createSampleImage({
			width: 200,
			height: 150,
			format: 'jpeg',
			withExif: true,
		});
		const initialMeta = await sharp(inputWithGps).metadata();
		expect(initialMeta.exif).toBeDefined();

		const processed = await processImage(inputWithGps);

		const originalMeta = await sharp(processed.originalBuffer).metadata();
		expect(originalMeta.exif).toBeUndefined();

		const previewMeta = await sharp(processed.previewBuffer).metadata();
		expect(previewMeta.exif).toBeUndefined();
	});

	test('generates valid dimensions, small thumbnail, and blurhash', async () => {
		const input = await createSampleImage({ width: 800, height: 600, format: 'png' });
		const processed = await processImage(input, undefined, '-0.5,0.75');

		expect(processed.mimeType).toBe('image/png');
		expect(processed.extension).toBe('png');
		expect(processed.meta.original).toEqual({
			width: 800,
			height: 600,
			size: '800x600',
			aspect: 800 / 600,
		});

		expect(processed.meta.small?.width).toBeLessThanOrEqual(512);
		expect(processed.meta.small?.height).toBeLessThanOrEqual(512);
		expect(processed.meta.focus).toEqual({ x: -0.5, y: 0.75 });
		expect(processed.blurhash.length).toBeGreaterThan(0);
	});

	test('throws UnprocessableError on non-image or invalid input', async () => {
		const invalidBuffer = Buffer.from('not an image at all');
		await expect(processImage(invalidBuffer)).rejects.toThrow(UnprocessableError);
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

		await expect(processImage(tiffBuffer)).rejects.toThrow(UnprocessableError);
	});

	test('throws UnprocessableError when image matrix exceeds limit', () => {
		expect(parseFocus('invalid')).toBeUndefined();
		expect(parseFocus('1.5,-2.0')).toEqual({ x: 1, y: -1 });
		expect(parseFocus('0.1,0.2')).toEqual({ x: 0.1, y: 0.2 });
	});
});
