import type { APActor } from 'activitypub-types';
import type express from 'express';
import { apex } from '../../apex.js';
import type { APObject as ApexObject } from '../../apex/index.js';
import { getIriByMastodonId } from '../../mastodonId.js';
import { getFollowing } from '../../social/follows.js';
import type { NoteObject } from '../../social/types.js';
import { isAPNote, toIdArray } from '../../utils.js';
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
	const note = iri === undefined ? undefined : await apex.store.getObject(iri);
	if (!isAPNote(note)) {
		throw new NotFoundError();
	}
	return note;
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
	const note = await loadStatus(id);
	const visibility = noteToVisibility(note);
	const author = toIdArray(note.attributedTo)[0];
	const needsFollowing =
		options?.loadFollowing === true ||
		(visibility === 'private' && viewer !== undefined && author !== viewer.id);
	const viewerFollowing = new Set(needsFollowing && viewer ? await getFollowing(viewer) : []);
	if (!isNoteVisibleTo(note, viewer?.id, viewerFollowing)) {
		throw new NotFoundError();
	}
	return { note, viewerFollowing };
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
