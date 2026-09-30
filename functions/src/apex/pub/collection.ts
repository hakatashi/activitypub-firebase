import type { Apex, APObject } from '../types.js';
import { first, firstString } from '../values.js';

// 'true' は先頭ページ、Infinity は全件 (内部用)、それ以外の文字列は直前ページ末尾の _id
export type CollectionPage = string | number | undefined;

type Remapper = (item: APObject) => unknown;

const expectObject = (object: APObject | undefined, description: string): APObject => {
	if (!object) {
		throw new TypeError(`Failed to build ${description}`);
	}
	return object;
};

export const buildCollection = async function (
	this: Apex,
	id: string,
	isOrdered: boolean,
	totalItems: number,
): Promise<APObject> {
	const collection = await this.fromJSONLD({
		id,
		type: isOrdered ? 'OrderedCollection' : 'Collection',
		totalItems,
		first: this.addPageToIRI(id, true),
	});
	return expectObject(collection, `collection ${id}`);
};

export const buildCollectionPage = async function (
	this: Apex,
	collectionId: string,
	page: string | number,
	isOrdered: boolean,
	lastItemId: string | undefined,
): Promise<APObject> {
	const collectionPage = await this.fromJSONLD({
		id: this.addPageToIRI(collectionId, page),
		partOf: collectionId,
		type: isOrdered ? 'OrderedCollectionPage' : 'CollectionPage',
		next: lastItemId ? this.addPageToIRI(collectionId, lastItemId) : null,
	});
	return expectObject(collectionPage, `collection page of ${collectionId}`);
};

/**
 * Get a collection object or collection page objct
 * @param rawCollectionId - collection IRI (or a value holding it)
 * @param page - _id of item to begin querying after (i.e. last item of last page)
 *   or one of two special values: 'true' - get first page, Infinity - get all items (internal use only)
 * @param remapper - maps each item of the page
 * @param includePrivate - include non-public items
 * @param blockList - ids of actors whose activities should be excluded
 * @param query - additional filtering/aggregation passed through to store.getStream
 */
export const getCollection = async function (
	this: Apex,
	rawCollectionId: unknown,
	page?: CollectionPage,
	remapper?: Remapper | null,
	includePrivate?: boolean,
	blockList?: string[],
	query?: Record<string, unknown>[],
): Promise<APObject> {
	const collectionId = this.objectIdFromValue(rawCollectionId);
	if (collectionId === undefined) {
		throw new TypeError('Collection id is missing');
	}
	if (!page) {
		// if page isn't specified, just collection description is served
		const totalItems = await this.store.getStreamCount(collectionId);
		return this.buildCollection(collectionId, true, totalItems);
	}
	let after: string | null = typeof page === 'string' ? page : null;
	let limit: number | null = this.itemsPerPage;
	if (page === 'true') {
		after = null;
	}
	if (page === Infinity) {
		after = null;
		limit = null;
	}
	const stream = await this.store.getStream(collectionId, limit, after, blockList, query);
	const pageObj = await this.buildCollectionPage(
		collectionId,
		page,
		true,
		// determine next page prior to filtering so
		// you can pass large blocks of filtered activities
		stream.at(-1)?._id,
	);
	const visible: APObject[] = includePrivate ? stream : stream.filter((act) => this.isPublic(act));
	pageObj.orderedItems = remapper ? visible.map(remapper) : visible;
	return pageObj;
};

// non-exported utils
const idRemapper: Remapper = (object) => object.id;
const actorFromActivity: Remapper = (activity) => first(activity.actor);
const objectFromActivity: Remapper = (activity) => first(activity.object);

export const getInbox = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	return this.getCollection(
		first(actor.inbox),
		page,
		null,
		includePrivate,
		actor._local?.blockList,
	);
};

export const getOutbox = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	return this.getCollection(first(actor.outbox), page, null, includePrivate);
};

export const getFollowers = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	return this.getCollection(
		first(actor.followers),
		page,
		actorFromActivity,
		includePrivate,
		actor._local?.blockList,
	);
};

export const getFollowing = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	return this.getCollection(
		first(actor.following),
		page,
		this.objectIdFromActivity,
		includePrivate,
	);
};

export const getLiked = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	return this.getCollection(first(actor.liked), page, objectFromActivity, includePrivate);
};

export const getShares = function (
	this: Apex,
	object: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	return this.getCollection(first(object.shares), page, null, includePrivate);
};

export const getLikes = function (
	this: Apex,
	object: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	return this.getCollection(first(object.likes), page, null, includePrivate);
};

export const getAdded = function (
	this: Apex,
	actor: APObject,
	colId: string,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	const collectionIRI = this.utils.userCollectionIdToIRI(
		firstString(actor.preferredUsername) ?? '',
		colId,
	);
	return this.getCollection(collectionIRI, page, null, includePrivate);
};

export const getBlocked = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	const blockedIRI = this.utils.nameToBlockedIRI(firstString(actor.preferredUsername));
	return this.getCollection(blockedIRI, page, this.objectIdFromActivity, includePrivate);
};

export const getRejected = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	const rejectedIRI = this.utils.nameToRejectedIRI(firstString(actor.preferredUsername));
	return this.getCollection(rejectedIRI, page, idRemapper, includePrivate);
};

export const getRejections = function (
	this: Apex,
	actor: APObject,
	page?: CollectionPage,
	includePrivate?: boolean,
): Promise<APObject> {
	const rejectionsIRI = this.utils.nameToRejectionsIRI(firstString(actor.preferredUsername));
	return this.getCollection(rejectionsIRI, page, idRemapper, includePrivate);
};

export const updateCollection = async function (
	this: Apex,
	rawCollectionId: unknown,
): Promise<APObject | undefined> {
	const collectionId = this.objectIdFromValue(rawCollectionId);
	const info =
		collectionId === undefined ? undefined : this.utils.iriToCollectionInfo(collectionId);
	// shares/likes have to be embedded in their activity
	// for verifiable updates because the actor id is not in
	// the collection object
	if (info?.activity) {
		// updated embedded copies in activity
		return this.store.updateActivity(
			{
				id: this.utils.activityIdToIRI(info.activity),
				[info.name]: [await this.getCollection(collectionId)],
			},
			false,
		);
	}
	return undefined;
};
