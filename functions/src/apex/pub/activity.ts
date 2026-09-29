import type { Apex, APObject } from '../types.js';
import { first, isAPObject, isRecord, isString, stringArray, toArray } from '../values.js';

export const buildActivity = async function (
	this: Apex,
	type: string,
	actorId: string,
	to: unknown,
	etc: Record<string, unknown> = {},
): Promise<APObject> {
	const activityId = this.store.generateId();
	const collections = this.utils.idToActivityCollections(activityId);
	const merged = this.mergeJSONLD<Record<string, unknown>>(
		{
			id: this.utils.activityIdToIRI(activityId),
			type,
			actor: actorId,
			to,
			published: new Date().toISOString(),
		},
		etc,
	);
	const activity = await this.fromJSONLD(merged);
	if (!activity) {
		throw new TypeError(`Failed to build ${type} activity`);
	}
	activity.shares = [await this.buildCollection(collections.shares, true, 0)];
	activity.likes = [await this.buildCollection(collections.likes, true, 0)];
	return activity;
};

export const buildTombstone = (object: APObject): Promise<APObject> => {
	const deleted = new Date().toISOString();
	return Promise.resolve({
		id: object.id,
		type: 'Tombstone',
		deleted,
		published: deleted,
		updated: deleted,
	});
};

const sharedInboxOf = (actor: Record<string, unknown>): unknown => {
	const endpoints = first(actor.endpoints);
	return isRecord(endpoints) ? endpoints.sharedInbox : undefined;
};

// Not yet implemented: track errors during address resolution for redelivery attempts
export const address = async function (
	this: Apex,
	activity: APObject,
	sender: APObject,
	audienceOverride?: unknown[],
): Promise<string[]> {
	// ensure blocklist is available (e.g. if called outside of route)
	if (!sender._local?.blockList) {
		const blocked = await this.getBlocked(sender, Infinity, true);
		sender._local = { ...sender._local, blockList: stringArray(blocked.orderedItems) };
	}
	const { blockList } = sender._local;
	// de-dupe here to avoid resolving collections twice
	const audience = audienceOverride ?? Array.from(new Set(this.audienceFromActivity(activity)));
	const senderFollowers = first(sender.followers);
	const resolutions = audience.map((t) => {
		if (t === this.consts.publicAddress) {
			return null;
		}
		if (t === senderFollowers) {
			return this.getFollowers(sender, Infinity, true);
		}
		/* Allow addressing to sender's custom collections, e.g. a concept like a list
		 * of specific friends could be represented by a collection of Follow
		 * activities
		 * 7.1.1 "the server MUST target and deliver to... Collections owned by the actor."
		 */
		const miscCol = typeof t === 'string' ? this.utils.iriToCollectionInfo(t) : undefined;
		if (typeof t === 'string' && miscCol?.name === 'collections') {
			if (
				miscCol.actor === undefined ||
				!stringArray(sender.preferredUsername).includes(miscCol.actor)
			) {
				return null;
			}
			return this.getCollection(t, Infinity, undefined, true).then((col) => {
				col.orderedItems = toArray(col.orderedItems).flatMap((item) => {
					if (!isRecord(item)) {
						return [];
					}
					return [
						...toArray(item.actor),
						// in some cases, e.g. outgoing follows, the object is the actor
						// of interest
						...(item.object ? toArray(item.object).filter(isString) : []),
					];
				});
				return col;
			});
		}
		return this.resolveObject(t);
	});
	const resolved = (await Promise.allSettled(resolutions)).flatMap((result): unknown[] => {
		if (result.status !== 'fulfilled' || !isRecord(result.value)) {
			return [];
		}
		const { value } = result;
		if (value.inbox || first(sharedInboxOf(value))) {
			return [value];
		}
		if (value.items) {
			return toArray(value.items).map((id) => this.resolveObject(id));
		}
		if (value.orderedItems) {
			return toArray(value.orderedItems).map((id) => this.resolveObject(id));
		}
		return [];
	});
	// flattens and resolves collections
	const senderInbox = first(sender.inbox);
	const inboxes = (await Promise.allSettled(resolved)).flatMap((result) => {
		if (result.status !== 'fulfilled' || !isRecord(result.value)) {
			return [];
		}
		const { value } = result;
		if (typeof value.id === 'string' && blockList.includes(value.id)) {
			return [];
		}
		if (!value.inbox) {
			return [];
		}
		const inbox = first(value.inbox);
		// 7.1 exclude self
		if (inbox === senderInbox) {
			return [];
		}
		const target = first(sharedInboxOf(value)) || inbox;
		return typeof target === 'string' ? [target] : [];
	});
	// 7.1 de-dupe
	return Array.from(new Set(inboxes));
};

/** addToOutbox
 * Given a newly created activity, add it to the actor's outbox and publish it
 */
export const addToOutbox = async function (
	this: Apex,
	actor: APObject,
	activity: APObject,
): Promise<void> {
	this.addMeta(activity, 'collection', first(actor.outbox));
	await this.store.saveActivity(activity);
	return this.publishActivity(actor, activity);
};

// follow accept side effects: add to followers, publish updated followers
export const acceptFollow = async function (
	this: Apex,
	actor: APObject,
	targetActivity: APObject,
): Promise<{ postTask: () => Promise<void>; updated: APObject }> {
	const updated = await this.store.updateActivityMeta(
		targetActivity,
		'collection',
		first(actor.followers),
	);
	const postTask = async () => this.publishUpdate(actor, await this.getFollowers(actor));
	return { postTask, updated };
};

export const embedCollections = async function (this: Apex, activity: APObject): Promise<APObject> {
	if (this.isLocalIRI(activity.id)) {
		if (isString(first(activity.shares))) {
			activity.shares = [await this.getCollection(activity.shares)];
		}
		if (isString(first(activity.likes))) {
			activity.likes = [await this.getCollection(activity.likes)];
		}
	} else {
		if (isString(first(activity.shares))) {
			activity.shares = [await this.resolveObject(activity.shares, false, true)];
		}
		// if not paged, don't duplicate items in embedded copies
		const shares = first(activity.shares);
		if (isRecord(shares)) {
			delete shares.orderedItems;
		}
		if (isString(first(activity.likes))) {
			activity.likes = [await this.resolveObject(activity.likes, false, true)];
		}
		const likes = first(activity.likes);
		if (isRecord(likes)) {
			delete likes.orderedItems;
		}
	}
	return activity;
};

/** publishActivity
 * Prepare an activity for federated delivery, resolve addresses, and add
 * to delivery queue
 * @param actor - actor object with meta for request signing
 * @param activity - activity object
 * @param audienceOverride - array of IRIs, used in inbox forwarding to
 * skip normall addressing and deliver to specific audience
 */
export const publishActivity = async function (
	this: Apex,
	actor: APObject,
	activity: APObject,
	audienceOverride?: unknown[],
): Promise<void> {
	const [addresses, outgoingActivity] = await Promise.all([
		this.address(activity, actor, audienceOverride),
		this.toJSONLD(activity),
	]);
	if (addresses.length) {
		return this.queueForDelivery(actor, outgoingActivity, addresses);
	}
	return undefined;
};

const undoUpdatableCollections = new Set(['followers', 'following', 'liked', 'likes', 'shares']);

// undo may need to publish updates on behalf of multiple
// actors to completely clear the activity
export const publishUndoUpdate = async function (
	this: Apex,
	colId: unknown,
	actor: APObject,
	audience: unknown[],
): Promise<void> {
	const info = typeof colId === 'string' ? this.utils.iriToCollectionInfo(colId) : undefined;
	if (typeof colId !== 'string' || !info || !undoUpdatableCollections.has(info.name)) {
		return undefined;
	}
	let updated;
	let updatedActorId;
	if (info.activity) {
		updated = await this.updateCollection(colId);
		updatedActorId = first(updated?.actor);
	} else {
		updated = await this.getCollection(colId);
		updatedActorId = this.utils.usernameToIRI(info.actor);
	}
	if (!updated) {
		return undefined;
	}
	if (actor.id === updatedActorId) {
		return this.publishUpdate(actor, updated, audience);
	}
	const updatedActor =
		typeof updatedActorId === 'string'
			? await this.store.getObject(updatedActorId, true)
			: undefined;
	if (!updatedActor) {
		return undefined;
	}
	return this.publishUpdate(updatedActor, updated, audience);
};

export const publishUpdate = async function (
	this: Apex,
	actor: APObject,
	object: APObject,
	cc?: unknown,
): Promise<void> {
	const act = await this.buildActivity('Update', actor.id, first(actor.followers), { object, cc });
	return this.addToOutbox(actor, act);
};

export const resolveActivity = async function (
	this: Apex,
	id: unknown,
	includeMeta?: boolean,
): Promise<APObject | undefined> {
	let activity: unknown;
	if (this.validateActivity(id)) {
		// already activity
		activity = id;
	} else if (typeof id === 'string') {
		const stored = await this.store.getActivity(id, includeMeta);
		if (stored) {
			return stored;
		}
		// resolve remote activity object
		activity = await this.requestObject(id);
	} else {
		// do not try to fetch if this is an embedded object or otherwise invalid
		return undefined;
	}
	// avoid saving non-acticity objects to streams collection
	// if they are encountered during activity validation
	if (this.validateActivity(activity) && isAPObject(activity)) {
		await this.store.saveActivity(activity);
		return activity;
	}
	return undefined;
};
