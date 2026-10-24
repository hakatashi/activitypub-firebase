import ipaddr from 'ipaddr.js';
import type { NoteAttachment } from '../notes.js';
import { UnprocessableError } from './http/errors.js';

// URL.hostname は IPv6 リテラルを `[::1]` のように角括弧付きで返すため、
// ipaddr.js に渡す前に取り除く。
const stripBrackets = (hostname: string) =>
	hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

export const assertSafeMediaUrl = (urlString: string): URL => {
	if (urlString.length > 2048) {
		throw new UnprocessableError(`Validation failed: Media URL too long: ${urlString}`);
	}

	let parsed: URL;
	try {
		parsed = new URL(urlString);
	} catch {
		throw new UnprocessableError(`Validation failed: Invalid media URL: ${urlString}`);
	}

	if (parsed.protocol !== 'https:') {
		throw new UnprocessableError(
			`Validation failed: Media URL must use https scheme: ${urlString}`,
		);
	}

	if (parsed.username !== '' || parsed.password !== '') {
		throw new UnprocessableError(
			`Validation failed: Media URL must not contain user credentials: ${urlString}`,
		);
	}

	const hostname = stripBrackets(parsed.hostname).toLowerCase();
	if (hostname === '') {
		throw new UnprocessableError(`Validation failed: Invalid media URL hostname: ${urlString}`);
	}

	if (ipaddr.isValid(hostname)) {
		const range = ipaddr.process(hostname).range();
		if (range !== 'unicast') {
			throw new UnprocessableError(
				`Validation failed: Media URL points to a forbidden address: ${urlString}`,
			);
		}
		return parsed;
	}

	if (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname.endsWith('.local') ||
		hostname.endsWith('.internal') ||
		!hostname.includes('.')
	) {
		throw new UnprocessableError(
			`Validation failed: Media URL points to a forbidden host: ${urlString}`,
		);
	}

	return parsed;
};

export const inferMimeTypeFromUrl = (url: string): string => {
	try {
		const pathname = new URL(url).pathname.toLowerCase();
		if (pathname.endsWith('.png')) {
			return 'image/png';
		}
		if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
			return 'image/jpeg';
		}
		if (pathname.endsWith('.gif')) {
			return 'image/gif';
		}
		if (pathname.endsWith('.webp')) {
			return 'image/webp';
		}
		if (pathname.endsWith('.avif')) {
			return 'image/avif';
		}
		if (pathname.endsWith('.svg')) {
			return 'image/svg+xml';
		}
		if (pathname.endsWith('.heic')) {
			return 'image/heic';
		}
		if (pathname.endsWith('.heif')) {
			return 'image/heif';
		}
	} catch {
		// ignore
	}
	return 'image/jpeg';
};

export const parseDimension = (value: unknown): number | undefined => {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === 'number') {
		if (Number.isInteger(value) && value > 0) {
			return value;
		}
		throw new UnprocessableError('Validation failed: Dimensions must be positive integers');
	}
	if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
		return Number.parseInt(value.trim(), 10);
	}
	throw new UnprocessableError('Validation failed: Dimensions must be positive integers');
};

export const parseFocus = (focus: unknown): [number, number] | undefined => {
	if (focus === undefined || focus === null) {
		return undefined;
	}
	if (Array.isArray(focus) && focus.length >= 2) {
		const x = Number(focus[0]);
		const y = Number(focus[1]);
		if (Number.isFinite(x) && Number.isFinite(y) && x >= -1 && x <= 1 && y >= -1 && y <= 1) {
			return [x, y];
		}
		throw new UnprocessableError(
			'Validation failed: Focus points must be numbers between -1.0 and 1.0',
		);
	}
	if (typeof focus === 'object' && focus !== null && 'x' in focus && 'y' in focus) {
		const rec = focus as { x?: unknown; y?: unknown };
		const x = Number(rec.x);
		const y = Number(rec.y);
		if (Number.isFinite(x) && Number.isFinite(y) && x >= -1 && x <= 1 && y >= -1 && y <= 1) {
			return [x, y];
		}
		throw new UnprocessableError(
			'Validation failed: Focus points must be numbers between -1.0 and 1.0',
		);
	}
	throw new UnprocessableError('Validation failed: Invalid focus point format');
};

export interface NormalizedExternalMedia {
	url: string;
	description: string | null;
	mimeType: string;
	width?: number | undefined;
	height?: number | undefined;
	blurhash?: string | undefined;
	previewUrl?: string | undefined;
	focus?: [number, number] | undefined;
}

const extractMimeType = (record: Record<string, unknown>): string | undefined => {
	if (typeof record.mime_type === 'string' && record.mime_type.trim().length > 0) {
		return record.mime_type.trim();
	}
	if (typeof record.media_type === 'string' && record.media_type.trim().length > 0) {
		return record.media_type.trim();
	}
	return undefined;
};

const extractDescription = (record: Record<string, unknown>): string | null => {
	if (typeof record.description === 'string' && record.description.trim().length > 0) {
		return record.description.trim();
	}
	if (typeof record.name === 'string' && record.name.trim().length > 0) {
		return record.name.trim();
	}
	return null;
};

export const normalizeExternalMediaList = (rawMediaUrls: unknown): NormalizedExternalMedia[] => {
	if (rawMediaUrls === undefined || rawMediaUrls === null) {
		return [];
	}

	let candidates: unknown[] = [];
	if (Array.isArray(rawMediaUrls)) {
		candidates = rawMediaUrls;
	} else if (typeof rawMediaUrls === 'string') {
		const trimmed = rawMediaUrls.trim();
		if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				candidates = Array.isArray(parsed) ? parsed : [parsed];
			} catch {
				candidates = [trimmed];
			}
		} else if (trimmed.length > 0) {
			candidates = [trimmed];
		}
	} else if (typeof rawMediaUrls === 'object') {
		candidates = [rawMediaUrls];
	}

	const results: NormalizedExternalMedia[] = [];
	for (const raw of candidates) {
		if (typeof raw === 'string') {
			const url = raw.trim();
			assertSafeMediaUrl(url);
			results.push({
				url,
				description: null,
				mimeType: inferMimeTypeFromUrl(url),
			});
		} else if (typeof raw === 'object' && raw !== null) {
			const record = raw as Record<string, unknown>;
			if (typeof record.url !== 'string' || record.url.trim().length === 0) {
				throw new UnprocessableError('Validation failed: Each media_urls entry must have a url');
			}
			const url = record.url.trim();
			assertSafeMediaUrl(url);

			let previewUrl: string | undefined;
			const rawPreview = record.preview_url ?? record.previewUrl ?? record.thumbnail_url;
			if (typeof rawPreview === 'string' && rawPreview.trim().length > 0) {
				const preview = rawPreview.trim();
				assertSafeMediaUrl(preview);
				previewUrl = preview;
			}

			const width = parseDimension(record.width);
			const height = parseDimension(record.height);
			if (
				(width !== undefined && height === undefined) ||
				(width === undefined && height !== undefined)
			) {
				throw new UnprocessableError(
					'Validation failed: Both width and height must be specified together',
				);
			}

			const focus = parseFocus(record.focus ?? record.focal_point ?? record.focalPoint);
			const mimeType = extractMimeType(record) ?? inferMimeTypeFromUrl(url);

			const blurhash =
				typeof record.blurhash === 'string' && record.blurhash.trim().length > 0
					? record.blurhash.trim()
					: undefined;

			const description = extractDescription(record);

			results.push({
				url,
				description,
				mimeType,
				...(width === undefined ? {} : { width }),
				...(height === undefined ? {} : { height }),
				...(blurhash === undefined ? {} : { blurhash }),
				...(previewUrl === undefined ? {} : { previewUrl }),
				...(focus === undefined ? {} : { focus }),
			});
		} else {
			throw new UnprocessableError('Validation failed: Invalid entry in media_urls');
		}
	}

	const urls = results.map((item) => item.url);
	if (new Set(urls).size !== urls.length) {
		throw new UnprocessableError('Validation failed: Duplicate media URL');
	}

	return results;
};

export const externalMediaToNoteAttachment = (item: NormalizedExternalMedia): NoteAttachment => {
	const attachment: NoteAttachment = {
		type: 'Document',
		mediaType: item.mimeType,
		url: item.url,
		name: item.description,
		...(item.blurhash === undefined ? {} : { blurhash: item.blurhash }),
		...(item.width === undefined ? {} : { width: item.width }),
		...(item.height === undefined ? {} : { height: item.height }),
		...(item.focus === undefined ? {} : { focalPoint: item.focus }),
		icon: {
			type: 'Image',
			url: item.previewUrl ?? item.url,
		},
	};
	return attachment;
};
