import type { NextFunction, Request, Response } from 'express';
import type { APObject } from '../types.js';
import {
	errorMessage,
	first,
	firstString,
	isAPObject,
	isRecord,
	stringArray,
	toArray,
} from '../values.js';
import { getApex, getLocals } from './locals.js';

const needsResolveObject = ['announce', 'block', 'create', 'follow', 'like'];
const needsResolveActivity = ['accept', 'add', 'reject', 'remove'];
const needsLocalActivity = ['undo'];
const needsLocalObject = ['delete'];
const obxNeedsLocalObject = ['delete', 'update'];
const needsInlineObject = ['update'];
const obxNeedsInlineObject = ['create'];
const requiresObject = ['announce', 'create', 'delete', 'follow', 'like', 'update'];
const requiresActivityObject = ['accept', 'add', 'reject', 'remove'];
const obxRequiresActivityObject = ['accept', 'add', 'reject', 'remove', 'undo'];
const requiresObjectOwnership = ['delete', 'undo', 'update'];
const requiresTarget = ['add', 'remove'];

type ObjectResolution = Promise<APObject | null | undefined> | APObject | undefined;

// Accept の検証: Follow ならその Follow の object が accept した actor であること、
// それ以外なら accept された activity がその actor 宛てであること
const isAcceptableBy = (
	object: unknown,
	actorId: string,
	validateTarget: (object: unknown, targetId: string) => boolean,
) => {
	const accepted = isAPObject(object) ? object : undefined;
	if (accepted?.type.toLowerCase() === 'follow') {
		return validateTarget(accepted, actorId);
	}
	return toArray(accepted?.to).includes(actorId);
};

export const activityObject = (req: Request, res: Response, next: NextFunction): void => {
	const apex = getApex(req);
	const resLocal = getLocals(res);
	const activity: unknown = req.body;
	if (!apex.validateActivity(activity) || !isAPObject(activity)) {
		next();
		return;
	}

	const type = activity.type.toLowerCase();
	let object: ObjectResolution;
	if (needsResolveObject.includes(type) && activity.object) {
		object = apex.resolveObject(first(activity.object), true);
	} else if (needsResolveActivity.includes(type) && activity.object) {
		object = apex.resolveActivity(first(activity.object), true);
	} else if (needsLocalActivity.includes(type)) {
		const objectId = apex.objectIdFromActivity(activity);
		object = objectId === null ? undefined : apex.store.getActivity(objectId, true);
	} else if (needsLocalObject.includes(type)) {
		const objectId = apex.objectIdFromActivity(activity);
		object = objectId === null ? undefined : apex.store.getObject(objectId, true);
	} else if (needsInlineObject.includes(type) && apex.validateObject(activity.object)) {
		const inline = first(activity.object);
		object = isAPObject(inline) ? inline : undefined;
	}
	Promise.resolve(object)
		.then((obj) => {
			resLocal.object = obj ?? undefined;
			next();
		})
		.catch(next);
};

// confirm activity actor is sender and not blocked
// Not yet implemented: alternative authorization via JSON-LD signatures for forwarding
export const actor = (req: Request, res: Response, next: NextFunction): void => {
	const resLocal = getLocals(res);
	const { sender, target } = resLocal;
	if (!sender || !target) {
		next();
		return;
	}
	const apex = getApex(req);
	const body: unknown = req.body;
	if (isRecord(body) && body.actor) {
		const actorId = apex.actorIdFromActivity(body);
		if (actorId !== undefined && target._local?.blockList.includes(actorId)) {
			// skip processing, but don't inform blockee
			resLocal.status = 200;
			next();
			return;
		}
		apex
			.resolveObject(actorId)
			.then((resolvedActor) => {
				if (resolvedActor?.id === sender.id) {
					resLocal.actor = resolvedActor;
				}
				next();
			})
			.catch(next);
		return;
	}
	next();
};

export const inboxActivity = (req: Request, res: Response, next: NextFunction): void => {
	const resLocal = getLocals(res);
	const { object, actor: activityActor, target: recipient } = resLocal;
	if (!recipient || !activityActor) {
		next();
		return;
	}
	const apex = getApex(req);
	const activity: unknown = req.body;
	const tasks: Promise<unknown>[] = [];
	if (!apex.validateActivity(activity) || !isAPObject(activity)) {
		resLocal.status = 400;
		resLocal.statusMessage = 'Invalid activity';
		next();
		return;
	}
	// aditional validation for specific activites
	const type = activity.type.toLowerCase();
	if (requiresActivityObject.includes(type) && !apex.validateActivity(object)) {
		resLocal.status = 400;
		resLocal.statusMessage = `Activity type object requried for ${activity.type} activity`;
		next();
		return;
	}
	if (requiresObject.includes(type) && !apex.validateObject(object)) {
		resLocal.status = 400;
		resLocal.statusMessage = `Object requried for ${activity.type} activity`;
		next();
		return;
	}
	if (
		requiresObjectOwnership.includes(type) &&
		object &&
		!apex.validateOwner(object, activityActor)
	) {
		resLocal.status = 403;
		next();
		return;
	}
	if (type === 'update') {
		if (apex.validateActivity(object) && isAPObject(object)) {
			// update activity collection info
			tasks.push(apex.embedCollections(object));
		}
	} else if (type === 'delete' && object) {
		if (apex.validateActivity(object)) {
			resLocal.status = 400;
			resLocal.statusMessage = 'Activities cannot be deleted, use Undo';
			next();
			return;
		}
	} else if (type === 'undo' && object) {
		// only validate object if it was found, undo should succeed
		// if be processed after object was deleted
		if (!apex.validateActivity(object)) {
			resLocal.status = 400;
			resLocal.statusMessage = 'Undo can only be used on activities, use Delete';
		}
	} else if (type === 'accept' && !isAcceptableBy(object, activityActor.id, apex.validateTarget)) {
		// for follows, also confirm the follow object was the actor trying to accept it;
		// otherwise the activity being accepted was sent to the actor trying to accept it
		resLocal.status = 403;
		next();
		return;
	}
	tasks.push(apex.embedCollections(activity));
	Promise.all(tasks)
		.then(() => {
			apex.addMeta(activity, 'collection', first(recipient.inbox));
			resLocal.activity = true;
			next();
		})
		.catch(next);
};

export const jsonld = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
	const apex = getApex(req);
	const jsonldAccepted = req.accepts(apex.consts.jsonldTypes);
	// rule out */* requests
	const isJsonLdGet = req.method === 'GET' && !req.accepts('text/html');
	const isJsonLdProxy = req.method === 'POST' && Boolean(req.is(apex.consts.formUrlType));
	if (jsonldAccepted && (isJsonLdGet || isJsonLdProxy)) {
		getLocals(res).responseType = jsonldAccepted;
		next();
		return;
	}
	if (req.method === 'POST' && req.is(apex.consts.jsonldTypes)) {
		try {
			const obj = await apex.fromJSONLD(req.body);
			if (!obj) {
				res.status(400).send('Request body is not valid JSON-LD');
				return;
			}
			req.body = obj;
		} catch (err) {
			// potential fetch errors on context sources
			apex.logger.error('jsonld validation', errorMessage(err));
			res.status(400).send('Error processing request JSON-LD');
			return;
		}
		next();
		return;
	}
	next('route');
};

export const targetActivity = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const aid = req.params[apex.activityParam];
	const activityIRI = apex.utils.activityIdToIRI(aid);
	let activity;
	try {
		activity = await apex.store.getActivity(activityIRI);
	} catch (err) {
		next(err);
		return;
	}
	if (!activity) {
		res.status(404).send(`'${String(aid)}' not found`);
		return;
	}
	getLocals(res).target = activity;
	next();
};

export const targetActor = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const locals = getLocals(res);
	const actorName = req.params[apex.actorParam];
	const actorIRI = apex.utils.usernameToIRI(actorName);
	let actorObj;
	try {
		actorObj = await apex.store.getObject(actorIRI);
	} catch (err) {
		next(err);
		return;
	}
	if (!actorObj) {
		locals.status = 404;
		locals.statusMessage = `'${String(actorName)}' not found on this instance`;
	} else if (actorObj.type === 'Tombstone') {
		locals.status = 410;
	} else {
		locals.target = actorObj;
	}
	next();
};

// help prevent accidental disclosure of actor private keys by only
// including them when explicitly requested
export const targetActorWithMeta = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const resLocal = getLocals(res);
	const actorName = req.params[apex.actorParam];
	const actorIRI = apex.utils.usernameToIRI(actorName);
	try {
		const actorObj = await apex.store.getObject(actorIRI, true);
		if (!actorObj) {
			resLocal.status = 404;
			resLocal.statusMessage = `'${String(actorName)}' not found on this instance`;
		} else if (actorObj.type === 'Tombstone') {
			resLocal.status = 410;
		} else {
			// for temp in-memory storage
			actorObj._local = { blockList: [] };
			resLocal.target = actorObj;
			const blocked = await apex.getBlocked(actorObj, Infinity, true);
			actorObj._local.blockList = stringArray(blocked.orderedItems);
		}
	} catch (err) {
		next(err);
		return;
	}
	next();
};

export const targetObject = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const oid = req.params[apex.objectParam];
	const objIRI = apex.utils.objectIdToIRI(oid);
	let obj;
	try {
		obj = await apex.store.getObject(objIRI);
	} catch (err) {
		next(err);
		return;
	}
	if (!obj) {
		res.status(404).send(`'${String(oid)}' not found`);
		return;
	}
	getLocals(res).target = obj;
	next();
};

export const targetProxied = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const locals = getLocals(res);
	const body: unknown = req.body;
	if (!isRecord(body) || !body.id) {
		locals.status = 400;
		locals.statusMessage = 'Proxy requests is missing "id" parameter in form body';
		next();
		return;
	}
	try {
		locals.target = await apex.resolveUnknown(body.id);
	} catch (err) {
		next(err);
		return;
	}
	next();
};

const createExtraFields = ['bto', 'cc', 'bcc', 'audience'];

export const outboxCreate = (req: Request, res: Response, next: NextFunction): void => {
	const { target } = getLocals(res);
	const activity: unknown = req.body;
	if (!target || !isRecord(activity)) {
		next();
		return;
	}
	const apex = getApex(req);
	const actorIRI = target.id;
	activity.id = apex.utils.activityIdToIRI();
	let built;
	if (!apex.validateActivity(activity) || !isAPObject(activity)) {
		// if not valid activity, check for valid object and wrap in Create
		const object = activity;
		object.id = apex.utils.objectIdToIRI();
		if (!apex.validateObject(object)) {
			next();
			return;
		}
		object.attributedTo = [actorIRI];
		const extras: Record<string, unknown> = { object };
		for (const t of createExtraFields) {
			if (t in object) {
				extras[t] = object[t];
			}
		}
		built = apex.buildActivity('Create', actorIRI, object.to, extras);
	} else {
		const created = first(activity.object);
		if (activity.type.toLowerCase() === 'create' && isRecord(created)) {
			created.id = apex.utils.objectIdToIRI();
		}
		// run through builder to format & ensure published, shares, likes included
		built = apex.buildActivity(activity.type, actorIRI, activity.to, activity);
	}
	built
		.then((actResolved) => {
			req.body = actResolved;
			next();
		})
		.catch(next);
};

export const outboxActivityObject = (req: Request, res: Response, next: NextFunction): void => {
	const apex = getApex(req);
	const resLocal = getLocals(res);
	const { target } = resLocal;
	const activity: unknown = req.body;
	if (!target || !apex.validateActivity(activity) || !isAPObject(activity)) {
		next();
		return;
	}
	const type = activity.type.toLowerCase();
	let object: ObjectResolution;
	if (needsResolveObject.includes(type) && activity.object) {
		object = apex.resolveObject(first(activity.object), true);
	} else if (needsResolveActivity.includes(type) && activity.object) {
		object = apex.resolveActivity(first(activity.object), true);
	} else if (needsLocalActivity.includes(type)) {
		const objectId = apex.objectIdFromActivity(activity);
		object = objectId === null ? undefined : apex.store.getActivity(objectId, true);
	} else if (obxNeedsLocalObject.includes(type)) {
		const objectId = apex.objectIdFromActivity(activity);
		object = objectId === null ? undefined : apex.store.getObject(objectId, true);
	} else if (obxNeedsInlineObject.includes(type) && apex.validateObject(activity.object)) {
		const inline = first(activity.object);
		if (isAPObject(inline)) {
			inline.id = apex.utils.objectIdToIRI();
			object = inline;
		}
	}
	Promise.resolve(object)
		.then(async (obj) => {
			resLocal.object = obj ?? undefined;
			// for unfollow/unblock, clients dont have easy access to old activitiy ids,
			// so they can send an actor id and server will find related follow/block
			const actorId = apex.objectIdFromActivity(activity);
			if (obj || actorId === null) {
				next();
				return;
			}
			let related;
			if (type === 'undo' && target._local?.blockList.includes(actorId)) {
				const blockedCollection = apex.utils.nameToBlockedIRI(
					firstString(target.preferredUsername),
				);
				related = await apex.store.findActivityByCollectionAndObjectId(
					blockedCollection,
					actorId,
					true,
				);
			} else if (type === 'undo') {
				const following = firstString(target.following);
				related =
					following === undefined
						? undefined
						: await apex.store.findActivityByCollectionAndObjectId(following, actorId, true);
			} else if (type === 'reject') {
				const followers = firstString(target.followers);
				related =
					followers === undefined
						? undefined
						: await apex.store.findActivityByCollectionAndActorId(followers, actorId, true);
			}
			if (related) {
				activity.object = [related];
				resLocal.object = related;
			}
			next();
		})
		.catch((err: unknown) => {
			apex.logger.warn('Error resolving outbox activity object', errorMessage(err));
			next();
		});
};

const audienceFields = ['to', 'bto', 'cc', 'bcc', 'audience'];

export const outboxActivity = (req: Request, res: Response, next: NextFunction): void => {
	const resLocal = getLocals(res);
	const { target: activityActor, object } = resLocal;
	if (!activityActor) {
		next();
		return;
	}
	const apex = getApex(req);
	const activity: unknown = req.body;
	if (!apex.validateActivity(activity) || !isAPObject(activity)) {
		resLocal.status = 400;
		resLocal.statusMessage = 'Invalid activity';
		next();
		return;
	}
	const type = activity.type.toLowerCase();
	activity.id = apex.utils.activityIdToIRI();
	if (obxRequiresActivityObject.includes(type) && !apex.validateActivity(object)) {
		resLocal.status = 400;
		resLocal.statusMessage = `Activity type object requried for ${activity.type} activity`;
		next();
		return;
	}
	if (requiresObject.includes(type) && !apex.validateObject(object)) {
		resLocal.status = 400;
		resLocal.statusMessage = `Object requried for ${activity.type} activity`;
		next();
		return;
	}
	if (requiresTarget.includes(type) && !activity.target) {
		resLocal.status = 400;
		resLocal.statusMessage = `Target required for ${activity.type} activity`;
		next();
		return;
	}
	if (requiresObjectOwnership.includes(type) && !apex.validateOwner(object, activityActor)) {
		resLocal.status = 403;
		next();
		return;
	}
	if (type === 'accept') {
		// for follows, confirm the follow object was the actor trying to accept it;
		// for other accepts, check the activity being accepted was sent to the actor trying to accept it
		if (!isAcceptableBy(object, activityActor.id, apex.validateTarget)) {
			resLocal.status = 403;
			next();
			return;
		}
	} else if (type === 'create') {
		// per spec, ensure attributedTo and audience fields in object are correct
		if (isAPObject(object)) {
			object.attributedTo = [activityActor.id];
			for (const t of audienceFields) {
				if (t in activity) {
					object[t] = activity[t];
				} else {
					delete object[t];
				}
			}
		}
	} else if (type === 'delete') {
		if (apex.validateActivity(object)) {
			resLocal.status = 400;
			resLocal.statusMessage = 'Activities cannot be deleted, use Undo';
			next();
			return;
		}
	} else if (type === 'update') {
		// outbox updates can be partial, do merge
		const update = first(activity.object);
		if (isAPObject(object) && isRecord(update)) {
			const merged = apex.mergeJSONLD<Record<string, unknown>>(object, update);
			if (isAPObject(merged)) {
				resLocal.object = merged;
				activity.object = [merged];
			}
		}
	} else if (type === 'add' || type === 'remove') {
		const collectionIRI = firstString(activity.target);
		const colInfo =
			collectionIRI === undefined ? undefined : apex.utils.iriToCollectionInfo(collectionIRI);
		if (colInfo?.name !== 'collections') {
			// only adding to custom collections is implemented
			resLocal.status = 405;
			next();
			return;
		}
		if (
			colInfo.actor === undefined ||
			!stringArray(activityActor.preferredUsername).includes(colInfo.actor)
		) {
			resLocal.status = 403;
			next();
			return;
		}
	} else if (type === 'block') {
		// block id even if could not resolve
		if (!object) {
			resLocal.object = apex.objectIdFromActivity(activity) ?? undefined;
		}
		if (!resLocal.object) {
			resLocal.status = 400;
			resLocal.statusMessage = 'Block requires object';
			next();
			return;
		}
		resLocal.doNotPublish = true;
	}
	apex.addMeta(activity, 'collection', first(activityActor.outbox));
	resLocal.activity = true;
	next();
};
