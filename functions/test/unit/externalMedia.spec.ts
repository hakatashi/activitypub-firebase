import { describe, expect, test } from 'vitest';
import {
	assertSafeMediaUrl,
	externalMediaToNoteAttachment,
	inferMimeTypeFromUrl,
	normalizeExternalMediaList,
	parseDimension,
	parseFocus,
} from '../../src/mastodon/externalMedia.js';
import { UnprocessableError } from '../../src/mastodon/http/errors.js';

describe('externalMedia', () => {
	describe('assertSafeMediaUrl', () => {
		test('accepts valid https URLs', () => {
			expect(assertSafeMediaUrl('https://example.com/radar.png').href).toBe(
				'https://example.com/radar.png',
			);
			expect(assertSafeMediaUrl('https://sub.domain.test:8443/images/img.webp').href).toBe(
				'https://sub.domain.test:8443/images/img.webp',
			);
			expect(assertSafeMediaUrl('https://8.8.8.8/radar.png').href).toBe(
				'https://8.8.8.8/radar.png',
			);
		});

		test('rejects http URLs', () => {
			expect(() => assertSafeMediaUrl('http://example.com/radar.png')).toThrow(UnprocessableError);
		});

		test('rejects invalid or non-http protocols', () => {
			expect(() => assertSafeMediaUrl('ftp://example.com/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('javascript:alert(1)')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('not-a-valid-url')).toThrow(UnprocessableError);
		});

		test('rejects user credentials in URL', () => {
			expect(() => assertSafeMediaUrl('https://user:pass@example.com/radar.png')).toThrow(
				UnprocessableError,
			);
		});

		test('rejects loopback and local addresses', () => {
			expect(() => assertSafeMediaUrl('https://localhost/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://app.localhost/radar.png')).toThrow(
				UnprocessableError,
			);
			expect(() => assertSafeMediaUrl('https://127.0.0.1/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://[::1]/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://[::ffff:127.0.0.1]/radar.png')).toThrow(
				UnprocessableError,
			);
		});

		test('rejects link-local, private and unspecified IP addresses', () => {
			expect(() => assertSafeMediaUrl('https://169.254.169.254/latest/meta-data')).toThrow(
				UnprocessableError,
			);
			expect(() => assertSafeMediaUrl('https://10.0.0.1/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://172.16.0.1/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://192.168.1.1/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://0.0.0.0/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://[fe80::1]/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://[fc00::1]/radar.png')).toThrow(UnprocessableError);
			expect(() => assertSafeMediaUrl('https://[::]/radar.png')).toThrow(UnprocessableError);
		});

		test('rejects dotless and local hostnames', () => {
			expect(() => assertSafeMediaUrl('https://server.local/radar.png')).toThrow(
				UnprocessableError,
			);
			expect(() => assertSafeMediaUrl('https://server.internal/radar.png')).toThrow(
				UnprocessableError,
			);
			expect(() => assertSafeMediaUrl('https://myhost/radar.png')).toThrow(UnprocessableError);
		});

		test('rejects URLs exceeding 2048 characters', () => {
			const longUrl = `https://example.com/${'a'.repeat(2050)}`;
			expect(() => assertSafeMediaUrl(longUrl)).toThrow(UnprocessableError);
		});
	});

	describe('inferMimeTypeFromUrl', () => {
		test('infers correct image mime types from path extensions', () => {
			expect(inferMimeTypeFromUrl('https://example.com/test.png')).toBe('image/png');
			expect(inferMimeTypeFromUrl('https://example.com/test.jpg')).toBe('image/jpeg');
			expect(inferMimeTypeFromUrl('https://example.com/test.jpeg')).toBe('image/jpeg');
			expect(inferMimeTypeFromUrl('https://example.com/test.gif')).toBe('image/gif');
			expect(inferMimeTypeFromUrl('https://example.com/test.webp')).toBe('image/webp');
			expect(inferMimeTypeFromUrl('https://example.com/test.avif')).toBe('image/avif');
			expect(inferMimeTypeFromUrl('https://example.com/test.svg')).toBe('image/svg+xml');
			expect(inferMimeTypeFromUrl('https://example.com/test.heic')).toBe('image/heic');
			expect(inferMimeTypeFromUrl('https://example.com/test.heif')).toBe('image/heif');
		});

		test('defaults to image/jpeg for unknown or missing extensions', () => {
			expect(inferMimeTypeFromUrl('https://example.com/radar')).toBe('image/jpeg');
			expect(inferMimeTypeFromUrl('https://example.com/radar.bin')).toBe('image/jpeg');
		});
	});

	describe('parseDimension', () => {
		test('parses positive integers', () => {
			expect(parseDimension(1200)).toBe(1200);
			expect(parseDimension('800')).toBe(800);
			expect(parseDimension(undefined)).toBeUndefined();
			expect(parseDimension(null)).toBeUndefined();
		});

		test('rejects non-positive, non-integer or invalid values', () => {
			expect(() => parseDimension(0)).toThrow(UnprocessableError);
			expect(() => parseDimension(-100)).toThrow(UnprocessableError);
			expect(() => parseDimension(12.5)).toThrow(UnprocessableError);
			expect(() => parseDimension('abc')).toThrow(UnprocessableError);
			expect(() => parseDimension('-50')).toThrow(UnprocessableError);
			expect(() => parseDimension('0')).toThrow(UnprocessableError);
		});
	});

	describe('parseFocus', () => {
		test('parses valid focus points', () => {
			expect(parseFocus([-0.5, 0.5])).toEqual([-0.5, 0.5]);
			expect(parseFocus([0, 0])).toEqual([0, 0]);
			expect(parseFocus({ x: -1, y: 1 })).toEqual([-1, 1]);
			expect(parseFocus(undefined)).toBeUndefined();
			expect(parseFocus(null)).toBeUndefined();
		});

		test('rejects out of bounds focus points', () => {
			expect(() => parseFocus([1.5, 0])).toThrow(UnprocessableError);
			expect(() => parseFocus([-1.2, 0])).toThrow(UnprocessableError);
			expect(() => parseFocus('invalid')).toThrow(UnprocessableError);
		});
	});

	describe('normalizeExternalMediaList', () => {
		test('returns empty array when input is nullish', () => {
			expect(normalizeExternalMediaList(undefined)).toEqual([]);
			expect(normalizeExternalMediaList(null)).toEqual([]);
			expect(normalizeExternalMediaList([])).toEqual([]);
		});

		test('normalizes array of string URLs', () => {
			const res = normalizeExternalMediaList(['https://example.com/radar.png']);
			expect(res).toEqual([
				{
					url: 'https://example.com/radar.png',
					description: null,
					mimeType: 'image/png',
				},
			]);
		});

		test('normalizes array of objects with full metadata', () => {
			const res = normalizeExternalMediaList([
				{
					url: 'https://example.com/radar.png',
					description: 'Rain radar',
					mime_type: 'image/png',
					width: 1200,
					height: 800,
					blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
					preview_url: 'https://example.com/radar_thumb.png',
					focus: [0.1, -0.2],
				},
			]);
			expect(res).toEqual([
				{
					url: 'https://example.com/radar.png',
					description: 'Rain radar',
					mimeType: 'image/png',
					width: 1200,
					height: 800,
					blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
					previewUrl: 'https://example.com/radar_thumb.png',
					focus: [0.1, -0.2],
				},
			]);
		});

		test('accepts media_type and name as aliases', () => {
			const res = normalizeExternalMediaList([
				{
					url: 'https://example.com/radar.png',
					name: 'Radar name',
					media_type: 'image/webp',
				},
			]);
			expect(res).toEqual([
				{
					url: 'https://example.com/radar.png',
					description: 'Radar name',
					mimeType: 'image/webp',
				},
			]);
		});

		test('handles JSON string representation', () => {
			const json = JSON.stringify([
				{
					url: 'https://example.com/radar.png',
					description: 'Radar',
				},
			]);
			const res = normalizeExternalMediaList(json);
			expect(res).toHaveLength(1);
			expect(res[0]?.url).toBe('https://example.com/radar.png');
			expect(res[0]?.description).toBe('Radar');
		});

		test('rejects duplicate URLs', () => {
			expect(() =>
				normalizeExternalMediaList([
					'https://example.com/radar.png',
					'https://example.com/radar.png',
				]),
			).toThrow(UnprocessableError);
		});

		test('rejects partial dimensions (width without height or vice versa)', () => {
			expect(() =>
				normalizeExternalMediaList([
					{
						url: 'https://example.com/radar.png',
						width: 1200,
					},
				]),
			).toThrow(UnprocessableError);

			expect(() =>
				normalizeExternalMediaList([
					{
						url: 'https://example.com/radar.png',
						height: 800,
					},
				]),
			).toThrow(UnprocessableError);
		});
	});

	describe('externalMediaToNoteAttachment', () => {
		test('converts NormalizedExternalMedia to NoteAttachment', () => {
			const item = {
				url: 'https://example.com/radar.png',
				description: 'Rain radar',
				mimeType: 'image/png',
				width: 1200,
				height: 800,
				blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
				previewUrl: 'https://example.com/radar_thumb.png',
				focus: [0.1, -0.2] as [number, number],
			};

			const attachment = externalMediaToNoteAttachment(item);
			expect(attachment).toEqual({
				type: 'Document',
				mediaType: 'image/png',
				url: 'https://example.com/radar.png',
				name: 'Rain radar',
				blurhash: 'UBL_:y9F~q_3~q%M%M%M%M%M%M%M',
				width: 1200,
				height: 800,
				focalPoint: [0.1, -0.2],
				icon: {
					type: 'Image',
					url: 'https://example.com/radar_thumb.png',
				},
			});
		});

		test('defaults previewUrl to url if not specified', () => {
			const item = {
				url: 'https://example.com/radar.png',
				description: null,
				mimeType: 'image/png',
			};

			const attachment = externalMediaToNoteAttachment(item);
			expect(attachment.icon).toEqual({
				type: 'Image',
				url: 'https://example.com/radar.png',
			});
		});
	});
});
