import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { encode } from 'blurhash';
import sharp from 'sharp';
import type { APObject } from '../apex/index.js';
import { apex } from '../apex.js';
import type { NoteVisibility } from '../addressing.js';
import { noteToVisibility } from '../addressing.js';
import { uploadArchiveFile } from '../storage/media.js';
import { isAPNote, toArray, toIdArray, toStringValue } from '../utils.js';
import { resolveUrl } from './search.js';

const execFileAsync = promisify(execFile);

sharp.cache(false);
sharp.concurrency(1);

const ARCHIVE_THUMBNAIL_MAX_DIMENSION = 512;

const formatToMimeType: Record<string, string> = {
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
};

export interface ArchiveNoteObject {
	id: string;
	type?: string;
	published?: string;
	url?: string | null;
	attributedTo?: string;
	to?: string | string[];
	cc?: string | string[];
	summary?: string | null;
	inReplyTo?: string | null;
	sensitive?: boolean;
	content?: string;
	contentMap?: Record<string, string>;
	attachment?: unknown[];
	tag?: unknown[];
	[key: string]: unknown;
}

export interface ArchiveCreateItem {
	id?: string;
	type: 'Create';
	actor?: string;
	published?: string;
	to?: string | string[];
	cc?: string | string[];
	object: ArchiveNoteObject;
	[key: string]: unknown;
}

export interface ArchiveAnnounceItem {
	id?: string;
	type: 'Announce';
	actor?: string;
	published?: string;
	to?: string | string[];
	cc?: string | string[];
	object: string;
	[key: string]: unknown;
}

export type ArchiveItem =
	| ArchiveCreateItem
	| ArchiveAnnounceItem
	| { type: string; [key: string]: unknown };

export type ArchiveVisibility = NoteVisibility;

export interface ImportArchiveOptions {
	dryRun?: boolean | undefined;
	concurrency?: number | undefined;
	archiveDir?: string | undefined;
	onProgress?:
		| ((info: {
				index: number;
				total: number;
				status: 'imported' | 'imported_announce' | 'already_exists' | 'skipped_other' | 'failed';
				id?: string | undefined;
				visibility?: ArchiveVisibility | undefined;
				detail?: string | undefined;
		  }) => void)
		| undefined;
}

export interface ArchiveMediaTypeStat {
	count: number;
	bytes: number;
}

export interface ImportArchiveMediaSummary {
	totalFiles: number;
	uploadedFiles: number;
	alreadyUploadedFiles: number;
	totalBytes: number;
	uploadedBytes: number;
	byMediaType: Record<string, ArchiveMediaTypeStat>;
}

export interface ImportArchiveResult {
	total: number;
	imported: Array<{ id: string; oldUri: string; visibility: ArchiveVisibility }>;
	importedAnnounces: Array<{ id: string; oldUri: string; targetUri: string }>;
	alreadyExists: string[];
	skippedOther: number;
	failed: Array<{ oldUri?: string | undefined; reason: string }>;
	visibilityCounts: Record<ArchiveVisibility, number>;
	media: ImportArchiveMediaSummary;
}

const statusIdPattern = /(?:\/users\/[^/]+\/statuses\/|\/@[^/]+\/)(?<id>\d+)/u;
const digitsOnlyPattern = /^\d+$/u;
const SNOWFLAKE_PUBLISHED_TOLERANCE_MS = 5000;

export const extractStatusId = (uri: string): string | undefined => {
	const match = statusIdPattern.exec(uri);
	return match?.groups?.id;
};

// 旧 status ID が Snowflake 形式 (`id >> 16` が `published` の時刻と5秒以内で一致) なら、
// Snowflake 側のミリ秒タイムスタンプから ISO 8601 文字列を復元する (→ ADR-0126)。
// 2017年初期の非 Snowflake 連番 ID は元の `published` をそのまま返す。
export const resolveArchivePublished = (
	statusId: string | undefined,
	rawPublished: string | undefined,
): string => {
	const parsedPublished = rawPublished === undefined ? Number.NaN : Date.parse(rawPublished);
	if (
		statusId !== undefined &&
		digitsOnlyPattern.test(statusId) &&
		!Number.isNaN(parsedPublished)
	) {
		const snowflakeTimestamp = Number(BigInt(statusId) >> 16n);
		if (Math.abs(snowflakeTimestamp - parsedPublished) <= SNOWFLAKE_PUBLISHED_TOLERANCE_MS) {
			return new Date(snowflakeTimestamp).toISOString();
		}
	}
	return rawPublished ?? new Date().toISOString();
};

export const isOldActorStatusUri = (uri: string, oldActorIri: string): boolean => {
	const prefix = oldActorIri.endsWith('/') ? oldActorIri : `${oldActorIri}/`;
	return uri.startsWith(prefix) && extractStatusId(uri) !== undefined;
};

export const resolveArchiveNoteIri = (oldUri: string): string => {
	const id = extractStatusId(oldUri);
	if (id !== undefined) {
		return apex.utils.objectIdToIRI(id);
	}
	return apex.utils.objectIdToIRI();
};

export const resolveArchiveActivityIri = (oldActivityUri: string, noteId: string): string => {
	const id = extractStatusId(oldActivityUri) ?? extractStatusId(noteId);
	if (id !== undefined) {
		return apex.utils.activityIdToIRI(id);
	}
	return apex.utils.activityIdToIRI();
};

export const detectArchiveVisibility = (
	to: string[],
	cc: string[],
	followersIri: string,
): ArchiveVisibility => {
	return noteToVisibility({ to, cc }, followersIri);
};

export const convertAudience = (
	rawAudience: unknown,
	oldFollowersIri: string,
	newFollowersIri: string,
): string[] => {
	const list = toIdArray(rawAudience);
	return list.map((iri) => (iri === oldFollowersIri ? newFollowersIri : iri));
};

export const convertArchiveNote = (
	localActor: APObject,
	oldNote: ArchiveNoteObject,
	oldActorIri: string,
): { note: APObject; oldUri: string; visibility: ArchiveVisibility; statusId: string } => {
	const oldUri = oldNote.id;
	const statusId = extractStatusId(oldUri);
	assert(statusId !== undefined, `Failed to extract status id from uri: ${oldUri}`);

	const newNoteId = apex.utils.objectIdToIRI(statusId);
	const newFollowersIri = toIdArray(localActor.followers)[0];
	assert(
		newFollowersIri !== undefined,
		`Local actor has no followers collection: ${localActor.id}`,
	);

	const oldFollowersIri = `${oldActorIri}/followers`;
	const to = convertAudience(oldNote.to, oldFollowersIri, newFollowersIri);
	const cc = convertAudience(oldNote.cc, oldFollowersIri, newFollowersIri);

	const visibility = detectArchiveVisibility(to, cc, newFollowersIri);

	let inReplyTo: string | undefined;
	if (oldNote.inReplyTo) {
		const rawInReplyTo = toStringValue(oldNote.inReplyTo);
		if (rawInReplyTo) {
			if (isOldActorStatusUri(rawInReplyTo, oldActorIri)) {
				// 自アカウントの過去投稿への返信は新 IRI に解決する (ADR-0126)
				inReplyTo = resolveArchiveNoteIri(rawInReplyTo);
			} else {
				// リモートの投稿への返信は旧 URI のまま維持する
				inReplyTo = rawInReplyTo;
			}
		}
	}

	const published = resolveArchivePublished(statusId, oldNote.published);

	const note: APObject = {
		id: newNoteId,
		url: newNoteId,
		published,
		type: 'Note',
		attributedTo: localActor.id,
		to,
		cc,
		content: oldNote.content ?? '',
		...(oldNote.tag && toArray(oldNote.tag).length > 0 ? { tag: oldNote.tag } : {}),
		...(oldNote.contentMap ? { contentMap: oldNote.contentMap } : {}),
		...(oldNote.summary ? { summary: oldNote.summary } : {}),
		...(oldNote.sensitive === undefined ? {} : { sensitive: oldNote.sensitive }),
		...(inReplyTo === undefined ? {} : { inReplyTo }),
		...(oldNote.attachment && toArray(oldNote.attachment).length > 0
			? { attachment: oldNote.attachment }
			: {}),
		_meta: {
			legacyUri: oldUri,
		},
	};

	return { note, oldUri, visibility, statusId };
};

export const convertArchiveAnnounce = (
	localActor: APObject,
	announceItem: ArchiveAnnounceItem,
	options: { oldActorIri: string; targetNoteIri: string },
): { activity: APObject; oldUri: string; visibility: ArchiveVisibility; statusId?: string } => {
	const { oldActorIri, targetNoteIri } = options;
	const oldActivityUri = typeof announceItem.id === 'string' ? announceItem.id : undefined;
	const statusId = oldActivityUri ? extractStatusId(oldActivityUri) : undefined;
	const activityId =
		statusId === undefined ? apex.utils.activityIdToIRI() : apex.utils.activityIdToIRI(statusId);

	const newFollowersIri = toIdArray(localActor.followers)[0];
	assert(
		newFollowersIri !== undefined,
		`Local actor has no followers collection: ${localActor.id}`,
	);

	const oldFollowersIri = `${oldActorIri}/followers`;
	const to = convertAudience(announceItem.to, oldFollowersIri, newFollowersIri);
	const cc = convertAudience(announceItem.cc, oldFollowersIri, newFollowersIri);
	const visibility = detectArchiveVisibility(to, cc, newFollowersIri);
	const published = resolveArchivePublished(statusId, announceItem.published);

	const activity: APObject = {
		id: activityId,
		type: 'Announce',
		actor: localActor.id,
		published,
		to,
		cc,
		object: targetNoteIri,
		...(oldActivityUri === undefined
			? {}
			: {
					_meta: {
						legacyUri: oldActivityUri,
					},
				}),
	};

	const outboxIri = toIdArray(localActor.outbox)[0];
	if (outboxIri !== undefined) {
		apex.addMeta(activity, 'collection', outboxIri);
	}

	return {
		activity,
		oldUri: oldActivityUri ?? announceItem.object,
		visibility,
		...(statusId === undefined ? {} : { statusId }),
	};
};

export interface BuildArchiveCreateActivityOptions {
	oldActivityUri?: string | undefined;
	statusId?: string | undefined;
}

export const buildArchiveCreateActivity = (
	localActor: APObject,
	note: APObject,
	options: BuildArchiveCreateActivityOptions = {},
): APObject => {
	const { oldActivityUri, statusId } = options;
	let activityId: string;
	if (oldActivityUri) {
		activityId = resolveArchiveActivityIri(oldActivityUri, note.id);
	} else if (statusId) {
		activityId = apex.utils.activityIdToIRI(statusId);
	} else {
		activityId = apex.utils.activityIdToIRI();
	}

	const activity: APObject = {
		id: activityId,
		type: 'Create',
		actor: localActor.id,
		published: note.published,
		to: note.to,
		cc: note.cc,
		object: note,
	};

	const outboxIri = toIdArray(localActor.outbox)[0];
	if (outboxIri !== undefined) {
		apex.addMeta(activity, 'collection', outboxIri);
	}

	return activity;
};

export const toArchiveStoragePaths = (
	rawUrl: string,
): { storagePath: string; previewStoragePath: string } => {
	const normalized = rawUrl.replace(/^\/+/, '');
	const segments = normalized.split('/');
	if (
		normalized === '' ||
		segments.includes('..') ||
		segments.includes('.') ||
		!normalized.startsWith('media_attachments/')
	) {
		throw new Error(`Invalid archive attachment path: ${rawUrl}`);
	}
	const previewStoragePath = normalized.includes('/original/')
		? normalized.replace('/original/', '/small/')
		: path.posix.join(path.posix.dirname(normalized), `small_${path.posix.basename(normalized)}`);
	return { storagePath: normalized, previewStoragePath };
};

const isUploadedMediaUrl = (url: unknown): boolean =>
	typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'));

export const needsArchiveMediaImport = (
	oldNote: ArchiveNoteObject,
	existingObject: APObject | undefined,
	archiveDir: string | undefined,
): boolean => {
	if (archiveDir === undefined) {
		return false;
	}
	const oldAttachments = toArray(oldNote.attachment).filter(
		(item): item is Record<string, unknown> =>
			typeof item === 'object' &&
			item !== null &&
			typeof (item as Record<string, unknown>).url === 'string',
	);
	if (oldAttachments.length === 0) {
		return false;
	}
	if (existingObject === undefined) {
		return true;
	}
	const existingAttachments = toArray(existingObject.attachment).filter(
		(item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
	);
	if (existingAttachments.length !== oldAttachments.length) {
		return true;
	}
	return existingAttachments.some((att) => !isUploadedMediaUrl(att.url));
};

const processArchiveImageBuffer = async (
	buffer: Buffer,
	mimeType: string,
	existingBlurhash: string | undefined,
): Promise<{
	previewBuffer: Buffer;
	previewMimeType: string;
	width: number | undefined;
	height: number | undefined;
	blurhash: string | undefined;
}> => {
	const metadata = await sharp(buffer).metadata();
	const format = metadata.format;
	let thumbPipeline = sharp(buffer, { pages: 1 })
		.rotate()
		.resize(ARCHIVE_THUMBNAIL_MAX_DIMENSION, ARCHIVE_THUMBNAIL_MAX_DIMENSION, {
			fit: 'inside',
			withoutEnlargement: true,
		});
	if (format === 'gif') {
		thumbPipeline = thumbPipeline.gif();
	}
	const thumbRes = await thumbPipeline.toBuffer({ resolveWithObject: true });
	const previewMimeType = formatToMimeType[thumbRes.info.format] ?? mimeType;

	let blurhash = existingBlurhash;
	if (!blurhash) {
		try {
			const rawSample = await sharp(thumbRes.data)
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
			// blurhash 計算失敗時は未設定のままにする
		}
	}

	return {
		previewBuffer: thumbRes.data,
		previewMimeType,
		width: typeof metadata.width === 'number' && metadata.width > 0 ? metadata.width : undefined,
		height:
			typeof metadata.height === 'number' && metadata.height > 0 ? metadata.height : undefined,
		blurhash,
	};
};

interface ImportNoteAttachmentsParams {
	oldAttachments: unknown[];
	archiveDir: string;
	mediaSummary: ImportArchiveMediaSummary;
	dryRun: boolean;
	alreadyImported: boolean;
}

const importNoteAttachments = async ({
	oldAttachments,
	archiveDir,
	mediaSummary,
	dryRun,
	alreadyImported,
}: ImportNoteAttachmentsParams): Promise<unknown[]> => {
	const resolved: unknown[] = [];

	for (const rawItem of oldAttachments) {
		if (typeof rawItem !== 'object' || rawItem === null) {
			resolved.push(rawItem);
			continue;
		}
		const att = rawItem as Record<string, unknown>;
		const rawUrl = toStringValue(att.url);
		if (!rawUrl || isUploadedMediaUrl(rawUrl)) {
			resolved.push(att);
			continue;
		}

		const { storagePath, previewStoragePath } = toArchiveStoragePaths(rawUrl);
		const localFilePath = path.join(archiveDir, storagePath);
		assert(fs.existsSync(localFilePath), `Archive media file not found: ${localFilePath}`);
		const stat = fs.statSync(localFilePath);
		const mediaType = toStringValue(att.mediaType) ?? 'application/octet-stream';

		mediaSummary.totalFiles += 1;
		mediaSummary.totalBytes += stat.size;
		const typeStat = mediaSummary.byMediaType[mediaType] ?? { count: 0, bytes: 0 };
		typeStat.count += 1;
		typeStat.bytes += stat.size;
		mediaSummary.byMediaType[mediaType] = typeStat;

		if (alreadyImported) {
			mediaSummary.alreadyUploadedFiles += 1;
			resolved.push(att);
			continue;
		}

		if (dryRun) {
			mediaSummary.uploadedFiles += 1;
			mediaSummary.uploadedBytes += stat.size;
			resolved.push(att);
			continue;
		}

		const buffer = await fs.promises.readFile(localFilePath);
		if (mediaType.toLowerCase().startsWith('image/')) {
			const existingBlurhash =
				typeof att.blurhash === 'string' && att.blurhash.length > 0 ? att.blurhash : undefined;
			const processed = await processArchiveImageBuffer(buffer, mediaType, existingBlurhash);
			const [origUploaded, thumbUploaded] = await Promise.all([
				uploadArchiveFile({ storagePath, buffer, mimeType: mediaType }),
				uploadArchiveFile({
					storagePath: previewStoragePath,
					buffer: processed.previewBuffer,
					mimeType: processed.previewMimeType,
				}),
			]);

			if (origUploaded.alreadyExisted) {
				mediaSummary.alreadyUploadedFiles += 1;
			} else {
				mediaSummary.uploadedFiles += 1;
				mediaSummary.uploadedBytes +=
					buffer.length + (thumbUploaded.alreadyExisted ? 0 : processed.previewBuffer.length);
			}

			const width = typeof att.width === 'number' && att.width > 0 ? att.width : processed.width;
			const height =
				typeof att.height === 'number' && att.height > 0 ? att.height : processed.height;

			resolved.push({
				...att,
				type: typeof att.type === 'string' ? att.type : 'Document',
				mediaType,
				url: origUploaded.url,
				name: att.name ?? null,
				...(processed.blurhash === undefined ? {} : { blurhash: processed.blurhash }),
				...(width === undefined ? {} : { width }),
				...(height === undefined ? {} : { height }),
				icon: {
					type: 'Image',
					url: thumbUploaded.url,
				},
			});
		} else {
			const origUploaded = await uploadArchiveFile({ storagePath, buffer, mimeType: mediaType });
			if (origUploaded.alreadyExisted) {
				mediaSummary.alreadyUploadedFiles += 1;
			} else {
				mediaSummary.uploadedFiles += 1;
				mediaSummary.uploadedBytes += buffer.length;
			}

			resolved.push({
				...att,
				type: typeof att.type === 'string' ? att.type : 'Document',
				mediaType,
				url: origUploaded.url,
				name: att.name ?? null,
			});
		}
	}

	return resolved;
};

export const importArchiveItems = async (
	localActor: APObject,
	items: ArchiveItem[],
	options: ImportArchiveOptions = {},
): Promise<ImportArchiveResult> => {
	const { dryRun = false, concurrency = 5, archiveDir, onProgress } = options;

	const oldActorIri = items.find(
		(item) =>
			(item.type === 'Create' || item.type === 'Announce') && typeof item.actor === 'string',
	)?.actor as string | undefined;
	const resolvedOldActorIri = oldActorIri ?? 'https://pawoo.net/users/hakatashi';

	const result: ImportArchiveResult = {
		total: items.length,
		imported: [],
		importedAnnounces: [],
		alreadyExists: [],
		skippedOther: 0,
		failed: [],
		visibilityCounts: {
			public: 0,
			unlisted: 0,
			private: 0,
			direct: 0,
		},
		media: {
			totalFiles: 0,
			uploadedFiles: 0,
			alreadyUploadedFiles: 0,
			totalBytes: 0,
			uploadedBytes: 0,
			byMediaType: {},
		},
	};

	// リモート取得のバーストや同一投稿者の並行保存トランザクション競合を防ぐため直列化する
	let remoteResolutionQueue = Promise.resolve();
	const withRemoteResolutionLock = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = remoteResolutionQueue.then(fn, fn);
		remoteResolutionQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const processAnnounceItem = async (announceItem: ArchiveAnnounceItem, index: number) => {
		const rawTargetUri = typeof announceItem.object === 'string' ? announceItem.object : '';
		const oldActivityUri = typeof announceItem.id === 'string' ? announceItem.id : undefined;
		if (!rawTargetUri) {
			result.failed.push({
				oldUri: oldActivityUri,
				reason: 'Announce item is missing object URI',
			});
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'failed',
				id: oldActivityUri,
				detail: 'Missing object URI',
			});
			return;
		}

		const statusId = oldActivityUri ? extractStatusId(oldActivityUri) : undefined;
		if (statusId !== undefined) {
			const candidateActivityId = apex.utils.activityIdToIRI(statusId);
			const existingActivity = await apex.store.getActivity(candidateActivityId);
			if (existingActivity !== undefined) {
				result.alreadyExists.push(candidateActivityId);
				onProgress?.({
					index: index + 1,
					total: items.length,
					status: 'already_exists',
					id: candidateActivityId,
				});
				return;
			}
		}

		const isSelfTarget = isOldActorStatusUri(rawTargetUri, resolvedOldActorIri);

		if (dryRun) {
			const targetIri = isSelfTarget ? resolveArchiveNoteIri(rawTargetUri) : rawTargetUri;
			const converted = convertArchiveAnnounce(localActor, announceItem, {
				oldActorIri: resolvedOldActorIri,
				targetNoteIri: targetIri,
			});
			result.importedAnnounces.push({
				id: converted.activity.id,
				oldUri: converted.oldUri,
				targetUri: targetIri,
			});
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'imported_announce',
				id: converted.activity.id,
				visibility: converted.visibility,
			});
			return;
		}

		try {
			const targetNote = await withRemoteResolutionLock(() => {
				if (isSelfTarget) {
					return apex.store.getObject(resolveArchiveNoteIri(rawTargetUri));
				}
				return resolveUrl(rawTargetUri, true);
			});

			if (targetNote === undefined || !isAPNote(targetNote) || typeof targetNote.id !== 'string') {
				const reason = `Failed to resolve boosted status: ${rawTargetUri}`;
				result.failed.push({ oldUri: oldActivityUri ?? rawTargetUri, reason });
				onProgress?.({
					index: index + 1,
					total: items.length,
					status: 'failed',
					id: oldActivityUri ?? rawTargetUri,
					detail: reason,
				});
				return;
			}

			const converted = convertArchiveAnnounce(localActor, announceItem, {
				oldActorIri: resolvedOldActorIri,
				targetNoteIri: targetNote.id,
			});
			await apex.store.saveActivity(converted.activity);

			result.importedAnnounces.push({
				id: converted.activity.id,
				oldUri: converted.oldUri,
				targetUri: targetNote.id,
			});
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'imported_announce',
				id: converted.activity.id,
				visibility: converted.visibility,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			result.failed.push({ oldUri: oldActivityUri ?? rawTargetUri, reason });
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'failed',
				id: oldActivityUri ?? rawTargetUri,
				detail: reason,
			});
		}
	};

	const processItem = async (item: ArchiveItem, index: number) => {
		if (item.type === 'Announce') {
			await processAnnounceItem(item as ArchiveAnnounceItem, index);
			return;
		}

		if (item.type !== 'Create' || !item.object || typeof item.object !== 'object') {
			result.skippedOther++;
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'skipped_other',
			});
			return;
		}

		const createItem = item as ArchiveCreateItem;
		const oldNote = createItem.object;

		let converted: ReturnType<typeof convertArchiveNote>;
		try {
			converted = convertArchiveNote(localActor, oldNote, resolvedOldActorIri);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			result.failed.push({ oldUri: oldNote.id, reason });
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'failed',
				id: oldNote.id,
				detail: reason,
			});
			return;
		}

		const { note, oldUri, visibility, statusId } = converted;
		const initialActivity = buildArchiveCreateActivity(localActor, note, {
			oldActivityUri: createItem.id,
			statusId,
		});

		// 冪等性チェック: Note と Create アクティビティの双方が既に存在するか
		const [existingObject, existingActivity] = await Promise.all([
			apex.store.getObject(note.id),
			apex.store.getActivity(initialActivity.id),
		]);
		const mediaPending = needsArchiveMediaImport(oldNote, existingObject, archiveDir);

		if (existingObject !== undefined && existingActivity !== undefined && !mediaPending) {
			if (archiveDir !== undefined && oldNote.attachment) {
				try {
					await importNoteAttachments({
						oldAttachments: toArray(oldNote.attachment),
						archiveDir,
						mediaSummary: result.media,
						dryRun,
						alreadyImported: true,
					});
				} catch {
					// 既にインポート済みの場合は統計取得失敗を無視する
				}
			}
			result.visibilityCounts[visibility] = (result.visibilityCounts[visibility] ?? 0) + 1;
			result.alreadyExists.push(note.id);
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'already_exists',
				id: note.id,
				visibility,
			});
			return;
		}

		if (dryRun) {
			if (archiveDir !== undefined && oldNote.attachment) {
				try {
					await importNoteAttachments({
						oldAttachments: toArray(oldNote.attachment),
						archiveDir,
						mediaSummary: result.media,
						dryRun: true,
						alreadyImported: false,
					});
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					result.failed.push({ oldUri, reason });
					onProgress?.({
						index: index + 1,
						total: items.length,
						status: 'failed',
						id: note.id,
						detail: reason,
					});
					return;
				}
			}
			result.visibilityCounts[visibility] = (result.visibilityCounts[visibility] ?? 0) + 1;
			result.imported.push({ id: note.id, oldUri, visibility });
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'imported',
				id: note.id,
				visibility,
			});
			return;
		}

		try {
			if (
				archiveDir !== undefined &&
				oldNote.attachment &&
				toArray(oldNote.attachment).length > 0
			) {
				note.attachment = await importNoteAttachments({
					oldAttachments: toArray(oldNote.attachment),
					archiveDir,
					mediaSummary: result.media,
					dryRun: false,
					alreadyImported: false,
				});
			}

			const activity = buildArchiveCreateActivity(localActor, note, {
				oldActivityUri: createItem.id,
				statusId,
			});

			// Note を保存または更新 (Store#saveObject が Mastodon ID, _meta, 返信数などをトランザクションで設定)
			if (existingObject === undefined) {
				await apex.store.saveObject(note);
			} else if (mediaPending) {
				await apex.store.updateObject(note, localActor.id ?? null, true);
			}

			// Create アクティビティを保存または更新 (Store#saveActivity が outbox に載せ、Mastodon ID を設定)
			if (existingActivity === undefined) {
				await apex.store.saveActivity(activity);
			} else if (mediaPending) {
				await apex.store.updateActivity(activity, true);
			}

			result.visibilityCounts[visibility] = (result.visibilityCounts[visibility] ?? 0) + 1;
			result.imported.push({ id: note.id, oldUri, visibility });
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'imported',
				id: note.id,
				visibility,
			});
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			result.failed.push({ oldUri, reason });
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'failed',
				id: note.id,
				detail: reason,
			});
		}
	};

	// 自アカウント投稿へのブーストが未保存の Note を参照する競合を防ぐため、
	// 第1パスで Create / その他を処理し、第2パスで Announce を処理する
	const indexedItems = items.map((item, index) => ({ item, index }));
	const firstPassItems = indexedItems.filter(({ item }) => item.type !== 'Announce');
	const secondPassItems = indexedItems.filter(({ item }) => item.type === 'Announce');

	const runPool = async (entries: Array<{ item: ArchiveItem; index: number }>) => {
		let cursor = 0;
		const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
			while (cursor < entries.length) {
				const entry = entries[cursor++];
				if (entry !== undefined) {
					await processItem(entry.item, entry.index);
				}
			}
		});
		await Promise.all(workers);
	};

	await runPool(firstPassItems);
	await runPool(secondPassItems);

	return result;
};

const parseOutboxJson = (jsonContent: string): ArchiveItem[] => {
	const parsed = JSON.parse(jsonContent) as { orderedItems?: ArchiveItem[]; items?: ArchiveItem[] };
	const items = parsed.orderedItems ?? parsed.items;
	assert(Array.isArray(items), `Invalid outbox.json: orderedItems or items is not an array`);
	return items;
};

export const readArchiveOutbox = async (archivePath: string): Promise<ArchiveItem[]> => {
	const resolvedPath = path.resolve(process.cwd(), archivePath);
	assert(fs.existsSync(resolvedPath), `Archive file/directory not found: ${resolvedPath}`);

	const stat = fs.statSync(resolvedPath);
	let jsonContent: string;

	if (stat.isDirectory()) {
		const outboxPath = path.join(resolvedPath, 'outbox.json');
		assert(fs.existsSync(outboxPath), `outbox.json not found in directory: ${resolvedPath}`);
		jsonContent = fs.readFileSync(outboxPath, 'utf-8');
	} else if (resolvedPath.endsWith('.tar.gz') || resolvedPath.endsWith('.tgz')) {
		// tar コマンドで標準出力へ outbox.json を取り出す
		const { stdout } = await execFileAsync(
			'tar',
			['-zxf', resolvedPath, '-O', 'outbox.json'],
			{ maxBuffer: 100 * 1024 * 1024 }, // 100MB
		);
		jsonContent = stdout;
	} else if (resolvedPath.endsWith('.json')) {
		jsonContent = fs.readFileSync(resolvedPath, 'utf-8');
	} else {
		throw new Error(`Unsupported archive format: ${resolvedPath}`);
	}

	return parseOutboxJson(jsonContent);
};

export interface PreparedArchiveSource {
	items: ArchiveItem[];
	archiveDir: string | undefined;
	cleanup?: (() => void) | undefined;
}

// アーカイブ (.tar.gz / ディレクトリ / outbox.json) を読み込み、
// メディア添付ファイルを参照できる展開済みディレクトリパスと cleanup 関数を返す (→ ADR-0127)。
export const prepareArchiveSource = async (archivePath: string): Promise<PreparedArchiveSource> => {
	const resolvedPath = path.resolve(process.cwd(), archivePath);
	assert(fs.existsSync(resolvedPath), `Archive file/directory not found: ${resolvedPath}`);

	const stat = fs.statSync(resolvedPath);
	if (stat.isDirectory()) {
		const outboxPath = path.join(resolvedPath, 'outbox.json');
		assert(fs.existsSync(outboxPath), `outbox.json not found in directory: ${resolvedPath}`);
		const items = parseOutboxJson(fs.readFileSync(outboxPath, 'utf-8'));
		return {
			items,
			archiveDir: resolvedPath,
		};
	}

	if (resolvedPath.endsWith('.tar.gz') || resolvedPath.endsWith('.tgz')) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mastodon-archive-'));
		try {
			await execFileAsync('tar', ['-zxf', resolvedPath, '-C', tempDir]);
			const outboxPath = path.join(tempDir, 'outbox.json');
			assert(fs.existsSync(outboxPath), `outbox.json not found in archive: ${resolvedPath}`);
			const items = parseOutboxJson(fs.readFileSync(outboxPath, 'utf-8'));
			return {
				items,
				archiveDir: tempDir,
				cleanup: () => {
					fs.rmSync(tempDir, { recursive: true, force: true });
				},
			};
		} catch (err) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			throw err;
		}
	}

	if (resolvedPath.endsWith('.json')) {
		const items = parseOutboxJson(fs.readFileSync(resolvedPath, 'utf-8'));
		const parentDir = path.dirname(resolvedPath);
		const hasMediaDir = fs.existsSync(path.join(parentDir, 'media_attachments'));
		return {
			items,
			archiveDir: hasMediaDir ? parentDir : undefined,
		};
	}

	throw new Error(`Unsupported archive format: ${resolvedPath}`);
};
