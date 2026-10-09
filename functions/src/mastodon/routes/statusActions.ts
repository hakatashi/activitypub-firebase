import express from 'express';
import assert from 'node:assert';
import firebase from 'firebase-admin';
import { apex } from '../../apex.js';
import { escapeFirestoreKey } from '../../firebase.js';
import { UserInfos } from '../../schema.js';
import type { APObject } from '../../apex/index.js';
import { getOrAssignMastodonId } from '../../mastodonId.js';
import { addBookmark, removeBookmark } from '../../social/bookmarks.js';
import { getReactionActivityIris, undoReactions } from '../../social/reactions.js';
import { getAttributedTo, toIdArray } from '../../utils.js';
import { authRequired, getOptionalViewer, scopeRequired } from '../http/auth.js';
import { UnprocessableError } from '../http/errors.js';
import { loadViewer, loadVisibleStatus } from '../http/loaders.js';
import {
	FOLLOWERS_PAGE_LIMITS,
	getReactedByPage,
	userIdsToAccounts,
} from '../presenters/account.js';
import { parsePageParams } from '../pagination.js';
import { setLinkHeader } from '../http/responses.js';
import {
	announceToStatus,
	getStatusById,
	getStatusByIri,
	getViewerRelationships,
} from '../presenters/status.js';
import { noteToVisibility } from '../statusAttributes.js';

const router = express.Router();

router.post(
	'/v1/statuses/:id/favourite',
	authRequired,
	scopeRequired('write:favourites'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { id, note } = await loadVisibleStatus(req.params.id, actor);

		const viewerRelations = await getViewerRelationships(actor, [note]);
		if (!viewerRelations.favourited.has(note.id)) {
			const to = toIdArray(note.attributedTo);
			const activity = await apex.buildActivity('Like', actor.id, to, {
				object: note.id,
			});
			await apex.addToOutbox(actor, activity);
		}

		const status = await getStatusById(id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

router.post(
	'/v1/statuses/:id/unfavourite',
	authRequired,
	scopeRequired('write:favourites'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { id, note } = await loadVisibleStatus(req.params.id, actor);

		await undoReactions(actor, note, 'favourites');

		const status = await getStatusById(id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

router.post(
	'/v1/statuses/:id/reblog',
	authRequired,
	scopeRequired('write:statuses'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { note } = await loadVisibleStatus(req.params.id, actor);

		const visibility = noteToVisibility(note);
		if (visibility === 'direct' || visibility === 'private') {
			throw new UnprocessableError('This post cannot be reblogged');
		}

		const viewerRelations = await getViewerRelationships(actor, [note]);
		let activity: APObject | undefined;
		if (viewerRelations.reblogged.has(note.id)) {
			const activityIris = await getReactionActivityIris(actor.id, 'reblogs', note.id);
			const latestIri = activityIris[activityIris.length - 1];
			if (latestIri !== undefined) {
				activity = await apex.store.getActivity(latestIri);
			}
			if (activity === undefined) {
				const followersIri = toIdArray(actor.followers)[0];
				const cc = [followersIri, ...toIdArray(note.attributedTo)].filter(
					(item): item is string => typeof item === 'string' && item.length > 0,
				);
				activity = await apex.buildActivity('Announce', actor.id, [apex.consts.publicAddress], {
					cc,
					object: note.id,
				});
				await apex.addToOutbox(actor, activity);
			}
		} else {
			const followersIri = toIdArray(actor.followers)[0];
			const cc = [followersIri, ...toIdArray(note.attributedTo)].filter(
				(item): item is string => typeof item === 'string' && item.length > 0,
			);
			activity = await apex.buildActivity('Announce', actor.id, [apex.consts.publicAddress], {
				cc,
				object: note.id,
			});
			await apex.addToOutbox(actor, activity);
		}

		assert(activity !== undefined, 'activity is undefined');
		const originalStatus = await getStatusByIri(note.id, actor);
		assert(originalStatus !== undefined, 'status is undefined');

		const [actorAccount] = await userIdsToAccounts([actor.id]);
		assert(actorAccount !== undefined, 'actorAccount is undefined');

		const announceMastodonId = await getOrAssignMastodonId(activity.id, activity.published);
		const status = announceToStatus(activity, actorAccount, announceMastodonId, originalStatus);
		res.json(status);
	},
);

router.post(
	'/v1/statuses/:id/unreblog',
	authRequired,
	scopeRequired('write:statuses'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { note } = await loadVisibleStatus(req.params.id, actor);

		await undoReactions(actor, note, 'reblogs');

		const status = await getStatusByIri(note.id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

router.post(
	'/v1/statuses/:id/bookmark',
	authRequired,
	scopeRequired('write:bookmarks'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { id, note } = await loadVisibleStatus(req.params.id, actor);

		await addBookmark(actor.id, note.id);

		const status = await getStatusById(id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

router.post(
	'/v1/statuses/:id/unbookmark',
	authRequired,
	scopeRequired('write:bookmarks'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { id, note } = await loadVisibleStatus(req.params.id, actor);

		await removeBookmark(actor.id, note.id);

		const status = await getStatusById(id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

router.post(
	'/v1/statuses/:id/pin',
	authRequired,
	scopeRequired('write:accounts'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { id, note, isAnnounce } = await loadVisibleStatus(req.params.id, actor);

		if (isAnnounce) {
			throw new UnprocessableError('You cannot pin a reblog');
		}

		if (getAttributedTo(note) !== actor.id) {
			throw new UnprocessableError('You can only pin your own posts');
		}

		if (noteToVisibility(note) === 'direct') {
			throw new UnprocessableError('You cannot pin direct posts');
		}

		const actorKey = escapeFirestoreKey(actor.id);
		const noteKey = escapeFirestoreKey(note.id);
		const pinsCollection = UserInfos.doc(actorKey).collection('pins');
		const pinsSnap = await pinsCollection.get();
		if (!pinsSnap.docs.some((doc) => doc.id === noteKey) && pinsSnap.size >= 5) {
			throw new UnprocessableError(
				'Validation failed: You have already pinned the maximum number of posts (5)',
			);
		}

		await pinsCollection
			.doc(noteKey)
			.set({ noteIri: note.id, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

		const status = await getStatusById(id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

router.post(
	'/v1/statuses/:id/unpin',
	authRequired,
	scopeRequired('write:accounts'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { id, note, isAnnounce } = await loadVisibleStatus(req.params.id, actor);

		if (!isAnnounce) {
			const actorKey = escapeFirestoreKey(actor.id);
			const noteKey = escapeFirestoreKey(note.id);
			await UserInfos.doc(actorKey).collection('pins').doc(noteKey).delete();
		}

		const status = await getStatusById(id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

// お気に入り / ブーストしたアカウントの一覧 (→ ADR-0101)。認証は任意で、Status が見えなければ 404。
for (const [path, kind] of [
	['favourited_by', 'favourites'],
	['reblogged_by', 'reblogs'],
] as const) {
	router.get(`/v1/statuses/:id/${path}`, async (req, res) => {
		const viewer = await getOptionalViewer(req, res);
		const { note } = await loadVisibleStatus(req.params.id, viewer);
		const { accounts, cursorIds } = await getReactedByPage(
			note.id,
			kind,
			parsePageParams(req.query, FOLLOWERS_PAGE_LIMITS),
		);
		setLinkHeader(req, res, cursorIds);
		res.json(accounts);
	});
}

export default router;
