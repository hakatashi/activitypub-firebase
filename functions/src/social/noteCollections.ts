import assert from 'node:assert';
import type { Query } from '@google-cloud/firestore';
import type { APActor } from 'activitypub-types';
import { uniq } from 'lodash-es';
import { escapeFirestoreKey } from '../firebase.js';
import type { PageParams } from '../pagination.js';
import { isAscending, lowerBoundId } from '../pagination.js';
import { Bookmarks, ReactionRelations } from '../schema.js';
import { getObjects } from '../store/objects.js';
import { getAttributedTo, isAPActor, isAPNote, toTypeArray } from '../utils.js';
import { getFollowing } from './follows.js';
import type { NoteObject } from './types.js';
import { isNoteVisibleTo } from './visibility.js';

// お気に入り・ブックマークの一覧 (→ ADR-0100)。どちらも `userInfos/{actor}/…/{Note}` のサブコレクションで、
// Status の ID ではなく、ドキュメントの `cursorId` (お気に入り・ブックマークした順) でページングする。

export type NoteCollectionKind = 'favourites' | 'bookmarks';

export interface NoteCollectionEntry {
	noteIri: string;
	cursorId: string;
}

// 閲覧できない Note を飛ばして読み足すときの上限。
const MAX_FETCH_ROUNDS = 5;

interface CursorDocument {
	cursorId: string | null;
}

const readEntries = async <T extends CursorDocument>(
	collection: Query<T>,
	toNoteIri: (data: T) => string,
	page: PageParams,
): Promise<NoteCollectionEntry[]> => {
	let query = collection;
	if (page.maxId !== undefined) {
		query = query.where('cursorId', '<', page.maxId);
	}
	// cursorId が null のもの (Mastodon ID が未採番) はカーソルにできないので除く。
	// 文字列の範囲条件は null に一致しない。
	query = query.where('cursorId', '>', lowerBoundId(page) ?? '');
	const docs = await query
		.orderBy('cursorId', isAscending(page) ? 'asc' : 'desc')
		.limit(page.limit)
		.get();
	return docs.docs.map((doc) => {
		const data = doc.data();
		assert(data.cursorId !== null, 'cursorId is null');
		return { noteIri: toNoteIri(data), cursorId: data.cursorId };
	});
};

// カーソルに近い側から limit 件を、カーソルに近い順で返す (ascending なら古い順)。
export const getNoteCollectionPageEntries = (
	actorId: string,
	kind: NoteCollectionKind,
	page: PageParams,
): Promise<NoteCollectionEntry[]> => {
	const userInfoKey = escapeFirestoreKey(actorId);
	if (kind === 'favourites') {
		return readEntries(
			ReactionRelations(userInfoKey, 'favourites'),
			(relation) => relation.object,
			page,
		);
	}
	return readEntries(Bookmarks(userInfoKey), (bookmark) => bookmark.noteIri, page);
};

// noteIris のうち、viewer が閲覧でき、Status にできる Note を引く。
// Tombstone・手元から消えたもの・見えなくなったもの・投稿者を引けないものは含めない。
const getVisibleNotes = async (
	noteIris: string[],
	viewer: APActor,
	viewerFollowing: ReadonlySet<string>,
): Promise<Map<string, NoteObject>> => {
	// Status の件数に使う `_meta` 付きで読む (→ ADR-0102)。
	const notes = (await getObjects(noteIris, true)).filter(
		(object): object is NoteObject =>
			isAPNote(object) &&
			!toTypeArray(object.type).includes('Tombstone') &&
			getAttributedTo(object) !== undefined &&
			isNoteVisibleTo(object, viewer.id, viewerFollowing),
	);
	const authorIris = uniq(notes.map((note) => getAttributedTo(note) as string));
	const authors = new Set((await getObjects(authorIris)).filter(isAPActor).map(({ id }) => id));
	return new Map(
		notes
			.filter((note) => authors.has(getAttributedTo(note) as string))
			.map((note) => [note.id, note]),
	);
};

export interface NoteCollectionPage {
	// 新しい順
	notes: NoteObject[];
	// 読み進めたドキュメントのカーソル (飛ばしたものを含む)。新しい順。Link ヘッダに使う。
	cursorIds: string[];
}

// viewer のお気に入り / ブックマークを、お気に入り・ブックマークした順 (新しい順) に 1 ページ分返す。
// 閲覧できない Note は飛ばし、limit に満たなければ続きを読み足す。
export const getNoteCollectionPage = async (
	viewer: APActor,
	kind: NoteCollectionKind,
	page: PageParams,
): Promise<NoteCollectionPage> => {
	assert(viewer.id !== undefined, 'viewer.id is undefined');
	const ascending = isAscending(page);
	const viewerFollowing = new Set(await getFollowing(viewer));
	const notes: NoteObject[] = [];
	const cursorIds: string[] = [];

	let cursorPage = page;
	for (let round = 0; round < MAX_FETCH_ROUNDS && notes.length < page.limit; round++) {
		const entries = await getNoteCollectionPageEntries(viewer.id, kind, cursorPage);
		const visibleNotes = await getVisibleNotes(
			entries.map((entry) => entry.noteIri),
			viewer,
			viewerFollowing,
		);
		for (const entry of entries) {
			if (notes.length >= page.limit) {
				break;
			}
			cursorIds.push(entry.cursorId);
			const note = visibleNotes.get(entry.noteIri);
			if (note !== undefined) {
				notes.push(note);
			}
		}
		const last = entries.at(-1);
		if (last === undefined || entries.length < cursorPage.limit) {
			break;
		}
		// 読み進めた側へカーソルを進める。
		cursorPage = ascending
			? { ...cursorPage, minId: last.cursorId }
			: { ...cursorPage, maxId: last.cursorId };
	}

	return ascending
		? { notes: notes.reverse(), cursorIds: cursorIds.reverse() }
		: { notes, cursorIds };
};
