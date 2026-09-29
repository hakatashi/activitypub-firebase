import type { Apex, APObject } from '../types.js';
import { first, isAPObject, isRecord } from '../values.js';

// find object in local DB or fetch from origin server
export const resolveObject = async function (
	this: Apex,
	idOrObject: unknown,
	_includeMeta?: boolean,
	refresh?: boolean,
	localOnly?: boolean,
): Promise<APObject | undefined> {
	let object;
	let cached;
	const id = first(idOrObject);
	if (isAPObject(id)) {
		// already an object
		object = id;
	} else {
		const iri = new URL(String(id));
		// remove any hash from url
		cached = await this.store.getObject(
			`${iri.protocol}//${iri.host}${iri.pathname}${iri.search}`,
			true,
		);
		if (cached && !refresh) {
			return cached;
		}
		if (localOnly) {
			return undefined;
		}
		// resolve remote object from id
		object = await this.requestObject(String(id));
		if (!object) {
			throw new TypeError(`Failed to resolve object ${String(id)}`);
		}
	}
	// local collections are generated on-demand; not cached
	if (!this.isLocalCollection(object)) {
		await (cached ? this.store.updateObject(object, null, true) : this.store.saveObject(object));
	}
	return object;
};

export const resolveUnknown = async function (
	this: Apex,
	rawObjectOrIRI: unknown,
): Promise<APObject | null> {
	let object: unknown;
	if (!rawObjectOrIRI) {
		return null;
	}
	// For Link/Mention, we want to resolved the linked object
	const objectOrIRI =
		isRecord(rawObjectOrIRI) && rawObjectOrIRI.href ? first(rawObjectOrIRI.href) : rawObjectOrIRI;
	// check if already cached
	if (typeof objectOrIRI === 'string') {
		const activity = await this.store.getActivity(objectOrIRI);
		if (activity) {
			return activity;
		}
		const cached = await this.store.getObject(objectOrIRI);
		if (cached) {
			return cached;
		}
		/* As local collections are not represented in the DB, instead being generated
		 * on demand, they up getting requested via http below. Perhaps not the most efficient,
		 * but it avoids creating duplicative logic to resolve implementation-specific IRIs
		 * to collections. Just have to make sure this doesn't get saved back to the object cache
		 */
		object = await this.requestObject(objectOrIRI);
	} else {
		object = objectOrIRI;
	}
	// cache inline or newly fetched object
	if (this.validateActivity(object) && isAPObject(object)) {
		await this.store.saveActivity(object);
		return object;
	}
	if (isAPObject(object)) {
		// local collections are genreated on-demand; not cached
		if (!this.isLocalCollection(object)) {
			await this.store.saveObject(object);
		}
		return object;
	}
	// unable to resolve to a valid object
	return null;
};
