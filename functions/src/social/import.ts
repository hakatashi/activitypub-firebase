import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import type { APActor } from 'activitypub-types';
import { escapeFirestoreKey } from '../firebase.js';
import { Bookmarks, Objects } from '../schema.js';
import type { ListRecord } from '../schema.js';
import { isAPActor, isAPNote, toIdArray } from '../utils.js';
import { fetchWebfinger } from '../webfinger.js';
import { addBookmark } from './bookmarks.js';
import { followActor, getFollowFlags } from './follows.js';
import {
	DEFAULT_LIST_REPLIES_POLICY,
	addListAccounts,
	createList,
	getList,
	getLists,
} from './lists.js';
import { hostOf, parseUrl, resolveRemoteActor } from './remoteResolution.js';
import { resolveUrl } from './search.js';

export interface ImportFollowingOptions {
	dryRun?: boolean;
	intervalMs?: number;
	onProgress?: (info: {
		index: number;
		total: number;
		acct: string;
		status:
			| 'followed'
			| 'already_following'
			| 'pending_approval'
			| 'moved'
			| 'failed'
			| 'skipped_self';
		detail?: string;
	}) => void;
}

export interface ImportFollowingResult {
	total: number;
	followed: string[];
	alreadyFollowing: string[];
	pendingApproval: string[];
	moved: Array<{ acct: string; movedTo: string }>;
	skippedSelf: string[];
	failed: Array<{ acct: string; reason: string }>;
}

export interface ImportBookmarksOptions {
	dryRun?: boolean;
	intervalMs?: number;
	onProgress?: (info: {
		index: number;
		total: number;
		url: string;
		status: 'bookmarked' | 'already_bookmarked' | 'failed';
		detail?: string;
	}) => void;
}

export interface ImportBookmarksResult {
	total: number;
	bookmarked: string[];
	alreadyBookmarked: string[];
	failed: Array<{ url: string; reason: string }>;
}

const ACCT_PATTERN = /^@?(?<username>[^@\s/]+)@(?<host>[^@\s/]+)$/u;

// Mastodon の following_accounts.csv をパースしてアカウントアドレス (username@host) の配列を返す。
export const parseFollowingCsv = (csvContent: string): string[] => {
	const lines = csvContent.split(/\r?\n/);
	const accts: string[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}

		// ヘッダ行 (Account address,Show boosts,...) をスキップ
		if (line.toLowerCase().startsWith('account address')) {
			continue;
		}

		// カンマ区切りの第1カラムを取り出す (クォート囲み対応)
		const firstColumn = line
			.split(',')[0]
			?.trim()
			.replace(/^["']|["']$/g, '')
			.trim();
		if (!firstColumn) {
			continue;
		}

		const cleanAcct = firstColumn.startsWith('@') ? firstColumn.slice(1) : firstColumn;
		if (ACCT_PATTERN.test(cleanAcct)) {
			accts.push(cleanAcct);
		}
	}

	return Array.from(new Set(accts));
};

// Mastodon の bookmarks.csv をパースして投稿 URL の配列を返す。
export const parseBookmarksCsv = (csvContent: string): string[] => {
	const lines = csvContent.split(/\r?\n/);
	const urls: string[] = [];

	for (const rawLine of lines) {
		const line = rawLine
			.trim()
			.replace(/^["']|["']$/g, '')
			.trim();
		if (!line) {
			continue;
		}

		const parsed = parseUrl(line);
		if (parsed !== undefined && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
			urls.push(line);
		}
	}

	return Array.from(new Set(urls));
};

// リモートのアカウントを解決する (手元にあればキャッシュを返し、無ければ WebFinger + AP 取得)。
const resolveAccountByAcct = async (
	username: string,
	host: string,
): Promise<APActor | undefined> => {
	const lowerHost = host.toLowerCase();

	// まず手元キャッシュから探す (外部サーバー負荷軽減およびテスト容易化のため)
	const localSnapshot = await Objects.where('_meta.preferredUsername', '==', username).get();
	for (const doc of localSnapshot.docs) {
		const data = doc.data();
		if (isAPActor(data) && typeof data.id === 'string' && hostOf(data.id) === lowerHost) {
			return data as APActor;
		}
	}

	// WebFinger で actor IRI を取得
	const actorIri = await fetchWebfinger(username, lowerHost);
	if (actorIri === undefined) {
		return undefined;
	}

	// AP オブジェクトの解決 (手元になければ取得して保存)
	const object = await resolveRemoteActor(actorIri);
	if (object === undefined || !isAPActor(object)) {
		return undefined;
	}

	return object as APActor;
};

const getActorUsername = (actor: APActor): string | undefined => {
	const raw = (actor as { preferredUsername?: unknown }).preferredUsername;
	if (typeof raw === 'string') {
		return raw.toLowerCase();
	}
	if (Array.isArray(raw) && typeof raw[0] === 'string') {
		return raw[0].toLowerCase();
	}
	return undefined;
};

// following_accounts.csv からアカウントをインポートしてローカル actor でフォローする (ADR-0124)。
export const importFollowing = async (
	viewer: APActor,
	accounts: string[],
	options: ImportFollowingOptions = {},
): Promise<ImportFollowingResult> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');

	const { dryRun = false, intervalMs = 1000, onProgress } = options;
	const result: ImportFollowingResult = {
		total: accounts.length,
		followed: [],
		alreadyFollowing: [],
		pendingApproval: [],
		moved: [],
		skippedSelf: [],
		failed: [],
	};

	const viewerHost = hostOf(viewer.id);
	const viewerUsername = getActorUsername(viewer);

	for (let i = 0; i < accounts.length; i++) {
		const acct = accounts[i]!;
		const match = ACCT_PATTERN.exec(acct);
		if (!match?.groups) {
			result.failed.push({ acct, reason: 'Invalid account format' });
			onProgress?.({
				index: i + 1,
				total: accounts.length,
				acct,
				status: 'failed',
				detail: 'Invalid format',
			});
			continue;
		}

		const { username, host } = match.groups;
		if (!username || !host) {
			result.failed.push({ acct, reason: 'Invalid account format' });
			onProgress?.({
				index: i + 1,
				total: accounts.length,
				acct,
				status: 'failed',
				detail: 'Invalid format',
			});
			continue;
		}

		// 自アカウントはスキップ
		if (
			viewerHost !== undefined &&
			host.toLowerCase() === viewerHost &&
			viewerUsername !== undefined &&
			username.toLowerCase() === viewerUsername
		) {
			result.skippedSelf.push(acct);
			onProgress?.({ index: i + 1, total: accounts.length, acct, status: 'skipped_self' });
			continue;
		}

		try {
			const targetActor = await resolveAccountByAcct(username, host);
			if (targetActor === undefined || targetActor.id === undefined) {
				result.failed.push({ acct, reason: 'Failed to resolve actor via WebFinger' });
				onProgress?.({
					index: i + 1,
					total: accounts.length,
					acct,
					status: 'failed',
					detail: 'Unresolvable',
				});
				continue;
			}

			// 自分自身への Follow はスキップ
			if (targetActor.id === viewer.id) {
				result.skippedSelf.push(acct);
				onProgress?.({ index: i + 1, total: accounts.length, acct, status: 'skipped_self' });
				continue;
			}

			// 引っ越し済み (movedTo) のチェック (ADR-0124)
			const movedToList = toIdArray((targetActor as { movedTo?: unknown }).movedTo);
			if (movedToList.length > 0) {
				const movedTo = movedToList[0]!;
				result.moved.push({ acct, movedTo });
				onProgress?.({
					index: i + 1,
					total: accounts.length,
					acct,
					status: 'moved',
					detail: movedTo,
				});
				continue;
			}

			// 射影から現在の関係を判定
			const [flags] = await getFollowFlags(viewer, [targetActor.id]);
			assert(flags !== undefined, 'flags is undefined');

			if (flags.following) {
				result.alreadyFollowing.push(acct);
				onProgress?.({ index: i + 1, total: accounts.length, acct, status: 'already_following' });
				continue;
			}

			if (flags.requested) {
				result.pendingApproval.push(acct);
				onProgress?.({ index: i + 1, total: accounts.length, acct, status: 'pending_approval' });
				continue;
			}

			if (dryRun) {
				result.followed.push(acct);
				onProgress?.({
					index: i + 1,
					total: accounts.length,
					acct,
					status: 'followed',
					detail: '(dry-run)',
				});
			} else {
				const followResult = await followActor(viewer, targetActor, { skipRequested: true });
				if (followResult.followed) {
					result.followed.push(acct);
					onProgress?.({ index: i + 1, total: accounts.length, acct, status: 'followed' });
				} else {
					result.alreadyFollowing.push(acct);
					onProgress?.({ index: i + 1, total: accounts.length, acct, status: 'already_following' });
				}
			}

			if (intervalMs > 0 && i < accounts.length - 1) {
				await setTimeout(intervalMs);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			result.failed.push({ acct, reason });
			onProgress?.({
				index: i + 1,
				total: accounts.length,
				acct,
				status: 'failed',
				detail: reason,
			});
		}
	}

	return result;
};

// bookmarks.csv から投稿をインポートしてローカル actor でブックマークする (ADR-0124)。
export const importBookmarks = async (
	viewer: APActor,
	urls: string[],
	options: ImportBookmarksOptions = {},
): Promise<ImportBookmarksResult> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');

	const { dryRun = false, intervalMs = 1000, onProgress } = options;
	const result: ImportBookmarksResult = {
		total: urls.length,
		bookmarked: [],
		alreadyBookmarked: [],
		failed: [],
	};

	for (let i = 0; i < urls.length; i++) {
		const url = urls[i]!;

		try {
			// URL から Note を解決 (手元にあればキャッシュ、無ければリモート fetch)
			const noteObject = await resolveUrl(url, true);
			if (noteObject === undefined || !isAPNote(noteObject) || typeof noteObject.id !== 'string') {
				result.failed.push({ url, reason: 'Failed to resolve status' });
				onProgress?.({
					index: i + 1,
					total: urls.length,
					url,
					status: 'failed',
					detail: 'Unresolvable',
				});
				continue;
			}

			const noteIri = noteObject.id;

			// 既にブックマーク済みかチェック
			const existingDoc = await Bookmarks(escapeFirestoreKey(viewer.id))
				.doc(escapeFirestoreKey(noteIri))
				.get();

			if (existingDoc.exists) {
				result.alreadyBookmarked.push(url);
				onProgress?.({ index: i + 1, total: urls.length, url, status: 'already_bookmarked' });
				continue;
			}

			if (dryRun) {
				result.bookmarked.push(url);
				onProgress?.({
					index: i + 1,
					total: urls.length,
					url,
					status: 'bookmarked',
					detail: '(dry-run)',
				});
			} else {
				await addBookmark(viewer.id, noteIri);
				result.bookmarked.push(url);
				onProgress?.({ index: i + 1, total: urls.length, url, status: 'bookmarked' });
			}

			if (intervalMs > 0 && i < urls.length - 1) {
				await setTimeout(intervalMs);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			result.failed.push({ url, reason });
			onProgress?.({ index: i + 1, total: urls.length, url, status: 'failed', detail: reason });
		}
	}

	return result;
};

export interface ListCsvRow {
	listName: string;
	acct: string;
}

export type ImportListsStatus =
	| 'added'
	| 'followed_and_added'
	| 'already_member'
	| 'not_following'
	| 'moved'
	| 'failed';

export interface ImportListsOptions {
	dryRun?: boolean;
	intervalMs?: number;
	// 偽なら、フォローしていない相手をフォローせずに飛ばす (→ ADR-0133 決定7)
	follow?: boolean;
	onProgress?: (info: {
		index: number;
		total: number;
		listName: string;
		acct: string;
		status: ImportListsStatus;
		detail?: string;
	}) => void;
}

export interface ImportListsResult {
	total: number;
	createdLists: string[];
	added: ListCsvRow[];
	followedAndAdded: ListCsvRow[];
	alreadyMember: ListCsvRow[];
	notFollowing: ListCsvRow[];
	moved: Array<ListCsvRow & { movedTo: string }>;
	failed: Array<ListCsvRow & { reason: string }>;
}

// CSV の1行をカラムに分ける (RFC 4180 のクォート `"..."` と `""` のエスケープに対応)。
const splitCsvLine = (line: string): string[] => {
	const columns: string[] = [];
	let current = '';
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quoted) {
			if (char === '"' && line[i + 1] === '"') {
				current += '"';
				i++;
			} else if (char === '"') {
				quoted = false;
			} else {
				current += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			columns.push(current);
			current = '';
		} else {
			current += char;
		}
	}
	columns.push(current);
	return columns;
};

// Mastodon の lists.csv (ヘッダなしの `リスト名,acct`) をパースする。重複行は1つにまとめる。
export const parseListsCsv = (csvContent: string): ListCsvRow[] => {
	const rows: ListCsvRow[] = [];
	const seen = new Set<string>();
	for (const line of csvContent.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}
		const columns = splitCsvLine(line);
		if (columns.length < 2) {
			continue;
		}
		const listName = columns[0]!.trim();
		const rawAcct = columns[1]!.trim();
		const acct = rawAcct.startsWith('@') ? rawAcct.slice(1) : rawAcct;
		if (listName === '' || !ACCT_PATTERN.test(acct)) {
			continue;
		}
		const key = JSON.stringify([listName, acct.toLowerCase()]);
		if (!seen.has(key)) {
			seen.add(key);
			rows.push({ listName, acct });
		}
	}
	return rows;
};

// lists.csv からリストとメンバーをインポートする (→ ADR-0133 決定7)。
// Mastodon の `BulkImportRowService` と同じく、同名のリストが無ければ作り、フォローしていない相手はフォローしてから足す。
export const importLists = async (
	viewer: APActor,
	rows: ListCsvRow[],
	options: ImportListsOptions = {},
): Promise<ImportListsResult> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');
	const viewerId = viewer.id;

	const { dryRun = false, intervalMs = 1000, follow = true, onProgress } = options;
	const result: ImportListsResult = {
		total: rows.length,
		createdLists: [],
		added: [],
		followedAndAdded: [],
		alreadyMember: [],
		notFollowing: [],
		moved: [],
		failed: [],
	};

	// 同名のリストが複数あれば、最初に作られたものに足す (Mastodon の find_or_create_by と同じ)。
	// dry-run で作らなかったリストは、メンバーが空のものとして扱う。
	const listsByTitle = new Map<string, ListRecord | undefined>();
	for (const list of (await getLists(viewerId)).reverse()) {
		listsByTitle.set(list.title, list);
	}

	const findOrCreateList = async (title: string) => {
		if (listsByTitle.has(title)) {
			return listsByTitle.get(title);
		}
		const list = dryRun
			? undefined
			: await createList(viewerId, {
					title,
					repliesPolicy: DEFAULT_LIST_REPLIES_POLICY,
					exclusive: false,
				});
		if (!dryRun && list === undefined) {
			throw new Error('Reached the maximum number of lists');
		}
		listsByTitle.set(title, list);
		result.createdLists.push(title);
		return list;
	};

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		const report = (status: ImportListsStatus, detail?: string) =>
			onProgress?.({
				index: i + 1,
				total: rows.length,
				...row,
				status,
				...(detail === undefined ? {} : { detail }),
			});

		try {
			const list = await findOrCreateList(row.listName);
			const { username, host } = ACCT_PATTERN.exec(row.acct)!.groups!;
			const targetActor = await resolveAccountByAcct(username!, host!);
			if (targetActor === undefined || targetActor.id === undefined) {
				result.failed.push({ ...row, reason: 'Failed to resolve actor via WebFinger' });
				report('failed', 'Unresolvable');
				continue;
			}
			const targetId = targetActor.id;

			// 引っ越し済みの相手はフォローも追加もしない (→ ADR-0124 決定5)
			const movedTo = toIdArray((targetActor as { movedTo?: unknown }).movedTo)[0];
			if (movedTo !== undefined) {
				result.moved.push({ ...row, movedTo });
				report('moved', movedTo);
				continue;
			}

			if (list?.accounts.includes(targetId) === true) {
				result.alreadyMember.push(row);
				report('already_member');
				continue;
			}

			let followed = false;
			if (targetId !== viewerId) {
				const [flags] = await getFollowFlags(viewer, [targetId]);
				assert(flags !== undefined, 'flags is undefined');
				if (!flags.following && !flags.requested) {
					if (!follow) {
						result.notFollowing.push(row);
						report('not_following');
						continue;
					}
					if (!dryRun) {
						await followActor(viewer, targetActor, { skipRequested: true });
					}
					followed = true;
				}
			}

			if (!dryRun) {
				assert(list !== undefined, 'list is undefined');
				const added = await addListAccounts(viewer, list.id, [targetId]);
				if (!added.ok) {
					throw new Error(`Failed to add to list: ${added.error}`);
				}
				// 次の行の重複判定のため、保存した内容を読み直す
				listsByTitle.set(row.listName, (await getList(viewerId, list.id)) ?? list);
			}
			const dryRunDetail = dryRun ? 'dry-run' : undefined;
			if (followed) {
				result.followedAndAdded.push(row);
				report('followed_and_added', dryRunDetail);
			} else {
				result.added.push(row);
				report('added', dryRunDetail);
			}

			if (intervalMs > 0 && i < rows.length - 1) {
				await setTimeout(intervalMs);
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			result.failed.push({ ...row, reason });
			report('failed', reason);
		}
	}

	return result;
};
