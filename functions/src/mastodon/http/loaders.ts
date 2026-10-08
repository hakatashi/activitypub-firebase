import type { APActor, APNote } from 'activitypub-types';
import type express from 'express';
import { apex } from '../../apex.js';
import type { APObject as ApexObject } from '../../apex/index.js';
import { getIriByMastodonId } from '../../mastodonId.js';
import { getFollowing } from '../../social/follows.js';
import type { NoteObject } from '../../social/types.js';
import { isAPAnnounce, isAPNote, toIdArray } from '../../utils.js';
import { assertIsAPActor, resolveAccountActor } from '../presenters/account.js';
import type { ResolvedAccountActor } from '../presenters/account.js';
import { isNoteVisibleTo, noteToVisibility } from '../statusAttributes.js';
import { getAuthActorId } from './auth.js';
import { NotFoundError } from './errors.js';
import { idParamSchema } from './params.js';

// id は検証前のパスパラメーター (Express 5 の型では string | string[])。ここで検証する。
export const loadStatus = async (id: unknown): Promise<NoteObject> => {
	const parsed = idParamSchema.safeParse({ id });
	if (!parsed.success) {
		throw new NotFoundError();
	}
	const iri = await getIriByMastodonId(parsed.data.id);
	if (iri === undefined) {
		throw new NotFoundError();
	}
	const object = await apex.store.getObject(iri);
	if (isAPNote(object)) {
		return object;
	}
	const activity = await apex.store.getActivity(iri);
	if (isAPAnnounce(activity)) {
		const targetIri = toIdArray(activity.object)[0];
		if (targetIri !== undefined) {
			const targetNote = await apex.store.getObject(targetIri);
			if (isAPNote(targetNote)) {
				return targetNote;
			}
		}
	}
	throw new NotFoundError();
};

export interface VisibleStatusResult {
	note: NoteObject;
	viewerFollowing: Set<string>;
}

export interface LoadVisibleStatusOptions {
	loadFollowing?: boolean;
}

export const loadVisibleStatus = async (
	id: unknown,
	viewer?: (ApexObject & APActor) | APActor | undefined,
	options?: LoadVisibleStatusOptions,
): Promise<VisibleStatusResult> => {
	const parsed = idParamSchema.safeParse({ id });
	if (!parsed.success) {
		throw new NotFoundError();
	}
	const iri = await getIriByMastodonId(parsed.data.id);
	if (iri === undefined) {
		throw new NotFoundError();
	}
	const object = await apex.store.getObject(iri);
	if (isAPNote(object)) {
		const visibility = noteToVisibility(object);
		const author = toIdArray(object.attributedTo)[0];
		const needsFollowing =
			options?.loadFollowing === true ||
			(visibility === 'private' && viewer !== undefined && author !== viewer.id);
		const viewerFollowing = new Set(needsFollowing && viewer ? await getFollowing(viewer) : []);
		if (!isNoteVisibleTo(object, viewer?.id, viewerFollowing)) {
			throw new NotFoundError();
		}
		return { note: object, viewerFollowing };
	}
	const activity = await apex.store.getActivity(iri);
	if (isAPAnnounce(activity)) {
		const boostAuthor = toIdArray(activity.actor)[0];
		const boostVisibility = noteToVisibility(activity as unknown as APNote);
		const needsFollowing =
			options?.loadFollowing === true ||
			(boostVisibility === 'private' && viewer !== undefined && boostAuthor !== viewer.id);
		const viewerFollowing = new Set(needsFollowing && viewer ? await getFollowing(viewer) : []);
		if (!isNoteVisibleTo(activity as unknown as APNote, viewer?.id, viewerFollowing)) {
			throw new NotFoundError();
		}

		const targetIri = toIdArray(activity.object)[0];
		if (targetIri === undefined) {
			throw new NotFoundError();
		}
		const targetNote = await apex.store.getObject(targetIri);
		if (!isAPNote(targetNote)) {
			throw new NotFoundError();
		}
		const targetVisibility = noteToVisibility(targetNote);
		const targetAuthor = toIdArray(targetNote.attributedTo)[0];
		const targetNeedsFollowing =
			options?.loadFollowing === true ||
			(targetVisibility === 'private' && viewer !== undefined && targetAuthor !== viewer.id);
		const targetViewerFollowing = new Set(
			targetNeedsFollowing && viewer ? await getFollowing(viewer) : [],
		);
		if (!isNoteVisibleTo(targetNote, viewer?.id, targetViewerFollowing)) {
			throw new NotFoundError();
		}
		return { note: targetNote, viewerFollowing: targetViewerFollowing };
	}
	throw new NotFoundError();
};

export const loadAccount = async (id: unknown): Promise<ResolvedAccountActor> => {
	const parsed = idParamSchema.safeParse({ id });
	if (!parsed.success) {
		throw new NotFoundError();
	}
	const resolved = await resolveAccountActor(parsed.data.id);
	if (resolved === undefined) {
		throw new NotFoundError();
	}
	return resolved;
};

export const loadViewer = async (res: express.Response): Promise<ApexObject & APActor> => {
	const actorId = getAuthActorId(res);
	const actor = await apex.store.getObject(actorId, true);
	assertIsAPActor(actor);
	return actor;
};
