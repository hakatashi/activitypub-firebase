import express from 'express';
import assert from 'node:assert';
import firebase from 'firebase-admin';
import { apex } from '../../apex.js';
import { escapeFirestoreKey } from '../../firebase.js';
import { UserInfos } from '../../schema.js';
import { undoReactions } from '../../social/reactions.js';
import { getAttributedTo, toIdArray } from '../../utils.js';
import { authRequired, scopeRequired } from '../http/auth.js';
import { UnprocessableError } from '../http/errors.js';
import { loadViewer, loadVisibleStatus } from '../http/loaders.js';
import { getStatusByIri, getViewerRelationships } from '../presenters/status.js';
import { noteToVisibility } from '../statusAttributes.js';

const router = express.Router();

router.post(
	'/v1/statuses/:id/favourite',
	authRequired,
	scopeRequired('write:favourites'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const { note } = await loadVisibleStatus(req.params.id, actor);

		const viewerRelations = await getViewerRelationships(actor, [note]);
		if (!viewerRelations.favourited.has(note.id)) {
			const to = toIdArray(note.attributedTo);
			const activity = await apex.buildActivity('Like', actor.id, to, {
				object: note.id,
			});
			await apex.addToOutbox(actor, activity);
		}

		const status = await getStatusByIri(note.id, actor);
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
		const { note } = await loadVisibleStatus(req.params.id, actor);

		await undoReactions(actor, note, 'favourites');

		const status = await getStatusByIri(note.id, actor);
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
		if (!viewerRelations.reblogged.has(note.id)) {
			const followersIri = toIdArray(actor.followers)[0];
			const cc = [followersIri, ...toIdArray(note.attributedTo)].filter(
				(item): item is string => typeof item === 'string' && item.length > 0,
			);
			const activity = await apex.buildActivity('Announce', actor.id, [apex.consts.publicAddress], {
				cc,
				object: note.id,
			});
			await apex.addToOutbox(actor, activity);
		}

		const status = await getStatusByIri(note.id, actor);
		assert(status !== undefined, 'status is undefined');
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
		const { note } = await loadVisibleStatus(req.params.id, actor);

		const actorKey = escapeFirestoreKey(actor.id);
		const noteKey = escapeFirestoreKey(note.id);
		await UserInfos.doc(actorKey)
			.collection('bookmarks')
			.doc(noteKey)
			.set({ noteIri: note.id, createdAt: firebase.firestore.FieldValue.serverTimestamp() });

		const status = await getStatusByIri(note.id, actor);
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
		const { note } = await loadVisibleStatus(req.params.id, actor);

		const actorKey = escapeFirestoreKey(actor.id);
		const noteKey = escapeFirestoreKey(note.id);
		await UserInfos.doc(actorKey).collection('bookmarks').doc(noteKey).delete();

		const status = await getStatusByIri(note.id, actor);
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
		const { note } = await loadVisibleStatus(req.params.id, actor);

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

		const status = await getStatusByIri(note.id, actor);
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
		const { note } = await loadVisibleStatus(req.params.id, actor);

		const actorKey = escapeFirestoreKey(actor.id);
		const noteKey = escapeFirestoreKey(note.id);
		await UserInfos.doc(actorKey).collection('pins').doc(noteKey).delete();

		const status = await getStatusByIri(note.id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

export default router;
