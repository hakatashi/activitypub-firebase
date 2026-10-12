import assert from 'node:assert';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { APObject } from '../apex/index.js';
import { apex } from '../apex.js';
import type { NoteVisibility } from '../addressing.js';
import { noteToVisibility } from '../addressing.js';
import { toArray, toIdArray, toStringValue } from '../utils.js';

const execFileAsync = promisify(execFile);

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
	dryRun?: boolean;
	concurrency?: number;
	onProgress?: (info: {
		index: number;
		total: number;
		status: 'imported' | 'already_exists' | 'skipped_announce' | 'skipped_other' | 'failed';
		id?: string;
		visibility?: ArchiveVisibility;
		detail?: string;
	}) => void;
}

export interface ImportArchiveResult {
	total: number;
	imported: Array<{ id: string; oldUri: string; visibility: ArchiveVisibility }>;
	alreadyExists: string[];
	skippedAnnounce: string[];
	skippedOther: number;
	failed: Array<{ oldUri?: string; reason: string }>;
	visibilityCounts: Record<ArchiveVisibility, number>;
}

const statusIdPattern = /(?:\/users\/[^/]+\/statuses\/|\/@[^/]+\/)(?<id>\d+)/u;

export const extractStatusId = (uri: string): string | undefined => {
	const match = statusIdPattern.exec(uri);
	return match?.groups?.id;
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
			if (rawInReplyTo.startsWith(oldActorIri)) {
				// 自アカウントの過去投稿への返信は新 IRI に解決する (ADR-0126)
				inReplyTo = resolveArchiveNoteIri(rawInReplyTo);
			} else {
				// リモートの投稿への返信は旧 URI のまま維持する
				inReplyTo = rawInReplyTo;
			}
		}
	}

	const published = oldNote.published ?? new Date().toISOString();

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

export const importArchiveItems = async (
	localActor: APObject,
	items: ArchiveItem[],
	options: ImportArchiveOptions = {},
): Promise<ImportArchiveResult> => {
	const { dryRun = false, concurrency = 5, onProgress } = options;

	const oldActorIri = items.find((item) => item.type === 'Create' && typeof item.actor === 'string')
		?.actor as string | undefined;
	const resolvedOldActorIri = oldActorIri ?? 'https://pawoo.net/users/hakatashi';

	const result: ImportArchiveResult = {
		total: items.length,
		imported: [],
		alreadyExists: [],
		skippedAnnounce: [],
		skippedOther: 0,
		failed: [],
		visibilityCounts: {
			public: 0,
			unlisted: 0,
			private: 0,
			direct: 0,
		},
	};

	// 並行度制御のためのワーカープール
	let currentIndex = 0;

	const processItem = async (item: ArchiveItem, index: number) => {
		if (item.type === 'Announce') {
			let oldUri: string;
			if (typeof item.object === 'string') {
				oldUri = item.object;
			} else if (typeof item.id === 'string') {
				oldUri = item.id;
			} else {
				oldUri = `announce-${index}`;
			}
			result.skippedAnnounce.push(oldUri);
			onProgress?.({
				index: index + 1,
				total: items.length,
				status: 'skipped_announce',
				id: oldUri,
			});
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
		result.visibilityCounts[visibility] = (result.visibilityCounts[visibility] ?? 0) + 1;

		// 冪等性チェック: 既に存在するか
		const existing = await apex.store.getObject(note.id);
		if (existing !== undefined) {
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
			// Note を保存 (Store#saveObject が Mastodon ID, _meta, 返信数などをトランザクションで設定)
			await apex.store.saveObject(note);

			// Create アクティビティを保存 (Store#saveActivity が outbox に載せ、Mastodon ID を設定)
			const activity = buildArchiveCreateActivity(localActor, note, {
				oldActivityUri: createItem.id,
				statusId,
			});
			await apex.store.saveActivity(activity);

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

	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (currentIndex < items.length) {
			const index = currentIndex++;
			const item = items[index];
			if (item !== undefined) {
				await processItem(item, index);
			}
		}
	});

	await Promise.all(workers);

	return result;
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
			['-zxvf', resolvedPath, '-O', 'outbox.json'],
			{ maxBuffer: 100 * 1024 * 1024 }, // 100MB
		);
		jsonContent = stdout;
	} else if (resolvedPath.endsWith('.json')) {
		jsonContent = fs.readFileSync(resolvedPath, 'utf-8');
	} else {
		throw new Error(`Unsupported archive format: ${resolvedPath}`);
	}

	const parsed = JSON.parse(jsonContent) as { orderedItems?: ArchiveItem[]; items?: ArchiveItem[] };
	const items = parsed.orderedItems ?? parsed.items;
	assert(Array.isArray(items), `Invalid outbox.json: orderedItems or items is not an array`);

	return items;
};
