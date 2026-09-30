import type { NextFunction, Request, Response } from 'express';
import type { APObject } from '../types.js';
import { first, firstString, isAPObject } from '../values.js';
import { getApex, getLocals } from './locals.js';

// For collection display, store with objects resolved
// updates also get their objects denormalized during validation
const denormalizeObject = [
	// object objects
	'create',
	// activity objects
	'announce',
	'like',
	'add',
	'reject',
	'undo',
];

export const save = (req: Request, res: Response, next: NextFunction): void => {
	const resLocal = getLocals(res);
	const body: unknown = req.body;
	if (!resLocal.activity || !resLocal.target || !isAPObject(body)) {
		next();
		return;
	}
	const apex = getApex(req);
	let activity = body;
	if (denormalizeObject.includes(activity.type.toLowerCase()) && resLocal.object) {
		// save with resolved object for ease of rendering
		activity = apex.mergeJSONLD<APObject>(apex.mergeJSONLD<APObject>({}, activity), {
			object: [resLocal.object],
		});
	}
	apex.store
		.saveActivity(activity)
		.then((result) => {
			resLocal.isNewActivity = result.isNew;
			if (result.activity) {
				req.body = result.activity;
			}
			next();
		})
		.catch(next);
};

export const forwardFromInbox = (req: Request, res: Response, next: NextFunction): void => {
	const apex = getApex(req);
	const resLocal = getLocals(res);
	const { target, linked } = resLocal;
	const activity: unknown = req.body;
	if (!(resLocal.activity && target) || !isAPObject(activity)) {
		next();
		return;
	}
	// This is the first time the server has seen this Activity.
	if (resLocal.isNewActivity !== true) {
		next();
		return;
	}
	// The values of inReplyTo, object, target and/or tag are objects owned by the server
	if (!linked?.some((obj) => apex.isLocalIRI(obj.id))) {
		next();
		return;
	}
	// The values of to, cc, and/or audience contain a Collection owned by the server
	const audience = ['to', 'cc', 'audience']
		.flatMap((prop) => (activity[prop] ? [activity[prop]].flat() : []))
		/* Spec says any collection, but really only Followers contains actors
		 * and is used in addressing. Perhaps also Added, depending on what it is
		 * populated with.
		 */
		.filter((addr) => {
			const name =
				typeof addr === 'string' ? apex.utils.iriToCollectionInfo(addr)?.name : undefined;
			return name === 'followers' || name === 'collections';
		});
	if (audience.length) {
		resLocal.postWork.push(() => apex.publishActivity(target, activity, audience));
	}
	next();
};

export const inboxSideEffects = (req: Request, res: Response, next: NextFunction): void => {
	const resLocal = getLocals(res);
	const { target: recipient, actor } = resLocal;
	const body: unknown = req.body;
	if (!(resLocal.activity && actor) || !recipient || !isAPObject(body)) {
		next();
		return;
	}
	const toDo: Promise<unknown>[] = [];
	const apex = getApex(req);
	const actorId = actor.id;
	let activity = body;
	let object = isAPObject(resLocal.object) ? resLocal.object : undefined;
	resLocal.status = 200;
	/* isNewActivity:
		false - this inbox has seen this activity before
		'new collection' - known activity, new inbox
		true - first time seeing this activity
	*/
	if (resLocal.isNewActivity === false) {
		// ignore redundant deliveries to same inbox
		next();
		return;
	}
	switch (activity.type.toLowerCase()) {
		case 'accept': {
			const follow = object;
			if (
				follow &&
				apex.validateOwner(follow, recipient) &&
				follow.type.toLowerCase() === 'follow'
			) {
				toDo.push(
					(async () => {
						// Add orignal follow activity to following collection
						object = await apex.store.updateActivityMeta(
							follow,
							'collection',
							first(recipient.following),
						);
						resLocal.postWork.push(async () =>
							apex.publishUpdate(recipient, await apex.getFollowing(recipient), actorId),
						);
					})(),
				);
			}
			break;
		}
		case 'announce':
		case 'like': {
			const collectionName = activity.type.toLowerCase() === 'like' ? 'likes' : 'shares';
			const targetActivity = object;
			toDo.push(
				(async () => {
					// only owner processes the change so they can publish update
					if (
						targetActivity &&
						apex.validateOwner(targetActivity, recipient) &&
						targetActivity[collectionName]
					) {
						const collectionId = apex.objectIdFromValue(targetActivity[collectionName]);
						// add to object likes/shares collection, incrementing like/share count
						activity = await apex.store.updateActivityMeta(activity, 'collection', collectionId);
						// publish updated object with updated likes/shares count
						const updatedTarget = await apex.updateCollection(collectionId);
						if (updatedTarget) {
							resLocal.postWork.push(() => apex.publishUpdate(recipient, updatedTarget, actorId));
						}
					}
				})(),
			);
			break;
		}
		case 'delete':
			// if we don't have the object, no action needed
			if (object) {
				toDo.push(
					apex
						.buildTombstone(object)
						.then((tombstone) => apex.store.updateObject(tombstone, actorId, true)),
				);
			}
			break;
		case 'reject': {
			const rejected = object;
			if (rejected && apex.validateOwner(rejected, recipient)) {
				toDo.push(
					(async () => {
						const rejectionsIRI = apex.utils.nameToRejectionsIRI(
							firstString(recipient.preferredUsername),
						);
						object = await apex.store.updateActivityMeta(rejected, 'collection', rejectionsIRI);
						// reject is also the undo of a follow accept
						const following = first(recipient.following);
						if (apex.hasMeta(object, 'collection', following)) {
							object = await apex.store.updateActivityMeta(object, 'collection', following, true);
							resLocal.postWork.push(async () =>
								apex.publishUpdate(recipient, await apex.getFollowing(recipient)),
							);
						}
					})(),
				);
			}
			break;
		}
		case 'undo': {
			// unlike other activities, undo will process updates for all affected actors
			// on first delivery so it can be deleted immediately
			const undone = object;
			if (undone) {
				// deleting the activity also removes it from all collections,
				// undoing follows, blocks, shares, and likes
				toDo.push(apex.store.removeActivity(undone, actorId));
				resLocal.postWork.push(() => {
					// update any collections the activity was removed from
					const audience = apex.audienceFromActivity(undone).concat(actor.id);
					const updates = undone._meta?.collection?.map((colId) =>
						apex.publishUndoUpdate(colId, recipient, audience),
					);
					return updates && Promise.allSettled(updates);
				});
			}
			break;
		}
		case 'update':
			if (resLocal.isNewActivity === true && object) {
				if (apex.validateActivity(object)) {
					toDo.push(apex.store.updateActivity(object, true));
				} else {
					toDo.push(apex.store.updateObject(object, actorId, true));
				}
			}
			break;
		default:
			break;
	}
	Promise.all(toDo)
		.then(() => {
			// configure event hook to be triggered after response sent
			resLocal.eventName = 'apex-inbox';
			resLocal.eventMessage = { actor, activity, recipient, object };
			next();
		})
		.catch(next);
};

export const outboxSideEffects = (req: Request, res: Response, next: NextFunction): void => {
	const resLocal = getLocals(res);
	const { target: actor } = resLocal;
	const body: unknown = req.body;
	if (!actor || !resLocal.activity || !isAPObject(body)) {
		next();
		return;
	}
	const toDo: Promise<unknown>[] = [];
	const apex = getApex(req);
	let activity = body;
	let { object } = resLocal;
	resLocal.status = 201;
	resLocal.createdLocation = activity.id;

	const objectValue = isAPObject(object) ? object : undefined;
	switch (activity.type.toLowerCase()) {
		case 'accept':
			if (objectValue?.type.toLowerCase() === 'follow') {
				toDo.push(
					apex.acceptFollow(actor, objectValue).then(({ postTask, updated }) => {
						object = updated;
						resLocal.postWork.push(postTask);
					}),
				);
			}
			break;
		case 'block':
			toDo.push(
				(async () => {
					const blockedIRI = apex.utils.nameToBlockedIRI(firstString(actor.preferredUsername));
					activity = await apex.store.updateActivityMeta(activity, 'collection', blockedIRI);
				})(),
			);
			break;
		case 'create':
			if (objectValue) {
				toDo.push(apex.store.saveObject(objectValue));
			}
			break;
		case 'delete':
			if (objectValue) {
				toDo.push(
					apex
						.buildTombstone(objectValue)
						.then((tombstone) => apex.store.updateObject(tombstone, actor.id, true)),
				);
			}
			break;
		case 'like':
			toDo.push(
				(async () => {
					// add to object liked collection
					activity = await apex.store.updateActivityMeta(
						activity,
						'collection',
						first(actor.liked),
					);
					// publish update to shares count
					resLocal.postWork.push(async () => apex.publishUpdate(actor, await apex.getLiked(actor)));
				})(),
			);
			break;
		case 'update':
			if (objectValue) {
				toDo.push(apex.store.updateObject(objectValue, actor.id, true));
			}
			break;
		case 'add':
			if (objectValue) {
				toDo.push(
					(async () => {
						object = await apex.store.updateActivityMeta(
							objectValue,
							'collection',
							first(activity.target),
						);
					})(),
				);
			}
			break;
		case 'reject':
			if (objectValue) {
				toDo.push(
					(async () => {
						const rejectedIRI = apex.utils.nameToRejectedIRI(firstString(actor.preferredUsername));
						let rejected = await apex.store.updateActivityMeta(
							objectValue,
							'collection',
							rejectedIRI,
						);
						// undo prior follow accept, if applicable
						const followers = first(actor.followers);
						if (apex.hasMeta(rejected, 'collection', followers)) {
							rejected = await apex.store.updateActivityMeta(
								rejected,
								'collection',
								followers,
								true,
							);
							resLocal.postWork.push(async () =>
								apex.publishUpdate(actor, await apex.getFollowers(actor)),
							);
						}
						object = rejected;
					})(),
				);
			}
			break;
		case 'remove':
			if (objectValue) {
				toDo.push(
					(async () => {
						object = await apex.store.updateActivityMeta(
							objectValue,
							'collection',
							first(activity.target),
							true,
						);
					})(),
				);
			}
			break;
		case 'undo':
			if (objectValue) {
				// deleting the activity also removes it from all collections,
				// undoing follows, blocks, shares, and likes
				toDo.push(apex.store.removeActivity(objectValue, actor.id));
				resLocal.postWork.push(() => {
					// update any collections the activity was removed from
					const audience = apex.audienceFromActivity(objectValue);
					const updates = objectValue._meta?.collection?.map((colId) =>
						apex.publishUndoUpdate(colId, actor, audience),
					);
					return updates && Promise.allSettled(updates);
				});
			}
			break;
		default:
			break;
	}
	Promise.all(toDo)
		.then(() => {
			// configure event hook to be triggered after response sent
			resLocal.eventMessage = { actor, activity, object };
			resLocal.eventName = 'apex-outbox';
			if (!resLocal.doNotPublish) {
				// local activity object may have been updated (e.g. denormalized object);
				// send original req.body to outbox
				resLocal.postWork.unshift(() => apex.publishActivity(actor, body));
			}
			next();
		})
		.catch(next);
};

export const resolveThread = (req: Request, res: Response, next: NextFunction): void => {
	const apex = getApex(req);
	const resLocal = getLocals(res);
	const body: unknown = req.body;
	if (!resLocal.activity || !isAPObject(body)) {
		next();
		return;
	}
	apex
		.resolveReferences(body)
		.then((refs) => {
			resLocal.linked = refs;
			next();
		})
		.catch(next);
};
