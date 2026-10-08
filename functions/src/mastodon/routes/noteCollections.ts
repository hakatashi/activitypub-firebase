import express from 'express';
import type { NoteCollectionKind } from '../../social/noteCollections.js';
import { getNoteCollectionPage } from '../../social/noteCollections.js';
import { authRequired, scopeRequired } from '../http/auth.js';
import { loadViewer } from '../http/loaders.js';
import { setLinkHeader } from '../http/responses.js';
import { parsePageParams } from '../pagination.js';
import { notesToStatuses } from '../presenters/status.js';

const router = express.Router();

const PAGE_LIMITS = { defaultLimit: 20, maxLimit: 40 };

// お気に入り・ブックマークの一覧 (→ ADR-0100)。お気に入り・ブックマークした順 (新しい順) に返す。
// Link ヘッダのカーソルは Status の ID ではなく、お気に入り・ブックマーク自体の cursorId。
const listNoteCollection =
	(kind: NoteCollectionKind): express.RequestHandler =>
	async (req, res) => {
		const viewer = await loadViewer(res);
		const page = parsePageParams(req.query, PAGE_LIMITS);
		const { notes, cursorIds } = await getNoteCollectionPage(viewer, kind, page);
		const statuses = await notesToStatuses(notes, viewer);
		setLinkHeader(req, res, cursorIds);
		res.json(statuses);
	};

router.get(
	'/v1/favourites',
	authRequired,
	scopeRequired('read:favourites'),
	listNoteCollection('favourites'),
);

router.get(
	'/v1/bookmarks',
	authRequired,
	scopeRequired('read:bookmarks'),
	listNoteCollection('bookmarks'),
);

export default router;
