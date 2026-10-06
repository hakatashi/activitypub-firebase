import assert from 'node:assert';
import firebase from 'firebase-admin';
import { apex } from '../../apex.js';
import { getFollowing } from '../../social/follows.js';
import { escapeFirestoreKey } from '../../firebase.js';
import { getIriByMastodonId } from '../../mastodonId.js';
import { Streams, UserInfos } from '../../schema.js';
import {
	getAttributedTo,
	isAPAnnounce,
	isAPLike,
	isAPNote,
	isAPUndo,
	toIdArray,
} from '../../utils.js';
import { createAsyncRouter } from '../http/asyncRouter.js';
import { authRequired, scopeRequired } from '../http/auth.js';
import { unprocessable } from '../http/responses.js';
import { assertIsAPActor } from '../presenters/account.js';
import { getStatusByIri, getViewerRelationships } from '../presenters/status.js';
import { statusParamsSchema } from './statuses.js';
import { isNoteVisibleTo, noteToVisibility } from '../statusAttributes.js';

const router = createAsyncRouter();

router.post(
	'/v1/statuses/:id/favourite',
	authRequired,
	scopeRequired('write:favourites'),
	async (req, res) => {
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

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
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const [likeDocs, undoDocs] = await Promise.all([
			Streams.where('type', '==', 'Like').where('actor', 'array-contains', actor.id).get(),
			Streams.where('type', '==', 'Undo').where('actor', 'array-contains', actor.id).get(),
		]);

		const undoneIds = new Set(
			undoDocs.docs.flatMap((doc) => {
				const data = doc.data();
				return isAPUndo(data) ? toIdArray(data.object) : [];
			}),
		);

		const activeLikeDoc = likeDocs.docs.find(
			(doc) =>
				!undoneIds.has(doc.data().id) &&
				isAPLike(doc.data()) &&
				toIdArray(doc.data().object).includes(note.id),
		);

		if (activeLikeDoc !== undefined) {
			const like = activeLikeDoc.data();
			const cleanLike = { ...like };
			delete cleanLike._meta;
			const undoActivity = await apex.buildActivity(
				'Undo',
				actor.id,
				toIdArray(note.attributedTo),
				{
					object: cleanLike,
				},
			);
			await apex.addToOutbox(actor, undoActivity);
			await apex.store.removeActivity(like, actor.id);
		}

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
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const visibility = noteToVisibility(note);
		if (visibility === 'direct' || visibility === 'private') {
			unprocessable(res, 'This post cannot be reblogged');
			return;
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
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const [announceDocs, undoDocs] = await Promise.all([
			Streams.where('type', '==', 'Announce').where('actor', 'array-contains', actor.id).get(),
			Streams.where('type', '==', 'Undo').where('actor', 'array-contains', actor.id).get(),
		]);

		const undoneIds = new Set(
			undoDocs.docs.flatMap((doc) => {
				const data = doc.data();
				return isAPUndo(data) ? toIdArray(data.object) : [];
			}),
		);

		const activeAnnounceDoc = announceDocs.docs.find(
			(doc) =>
				!undoneIds.has(doc.data().id) &&
				isAPAnnounce(doc.data()) &&
				toIdArray(doc.data().object).includes(note.id),
		);

		if (activeAnnounceDoc !== undefined) {
			const announce = activeAnnounceDoc.data();
			const cleanAnnounce = { ...announce };
			delete cleanAnnounce._meta;
			const undoActivity = await apex.buildActivity('Undo', actor.id, toIdArray(announce.to), {
				cc: toIdArray(announce.cc),
				object: cleanAnnounce,
			});
			await apex.addToOutbox(actor, undoActivity);
			await apex.store.removeActivity(announce, actor.id);
		}

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
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

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
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

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
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		if (getAttributedTo(note) !== actor.id) {
			unprocessable(res, 'You can only pin your own posts');
			return;
		}

		if (noteToVisibility(note) === 'direct') {
			unprocessable(res, 'You cannot pin direct posts');
			return;
		}

		const actorKey = escapeFirestoreKey(actor.id);
		const noteKey = escapeFirestoreKey(note.id);
		const pinsCollection = UserInfos.doc(actorKey).collection('pins');
		const pinsSnap = await pinsCollection.get();
		if (!pinsSnap.docs.some((doc) => doc.id === noteKey) && pinsSnap.size >= 5) {
			unprocessable(
				res,
				'Validation failed: You have already pinned the maximum number of posts (5)',
			);
			return;
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
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		const viewerFollowing = new Set(await getFollowing(actor));
		if (!isNoteVisibleTo(note, actor.id, viewerFollowing)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actorKey = escapeFirestoreKey(actor.id);
		const noteKey = escapeFirestoreKey(note.id);
		await UserInfos.doc(actorKey).collection('pins').doc(noteKey).delete();

		const status = await getStatusByIri(note.id, actor);
		assert(status !== undefined, 'status is undefined');
		res.json(status);
	},
);

export default router;
