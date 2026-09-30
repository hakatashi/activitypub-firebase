import type { Apex, APObject } from '../types.js';
import { first, firstString, isAPObject, isHashtag, isRecord } from '../values.js';

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
		const objectId = typeof id.id === 'string' ? id.id : undefined;
		if (objectId) {
			cached =
				(await this.store.getObject(objectId, true)) ??
				(await this.store.getActivity(objectId, true));
			// 自サーバー所有のオブジェクトで既に DB に存在する場合は、既存のものを返し上書きしない (→ ADR-0053)
			if (cached && this.isLocalIRI(objectId)) {
				return cached;
			}
			if (cached && !refresh) {
				return cached;
			}
		}
	} else {
		const iri = new URL(String(id));
		// remove any hash from url
		cached =
			(await this.store.getObject(
				`${iri.protocol}//${iri.host}${iri.pathname}${iri.search}`,
				true,
			)) ??
			(await this.store.getActivity(
				`${iri.protocol}//${iri.host}${iri.pathname}${iri.search}`,
				true,
			));
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
	if (!rawObjectOrIRI || isHashtag(rawObjectOrIRI)) {
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
	} else if (isRecord(objectOrIRI) && objectOrIRI.id) {
		const id = firstString(objectOrIRI.id);
		if (id !== undefined) {
			// 自サーバー所有のオブジェクトならローカル DB から返し、上書き保存しない (→ ADR-0053)
			if (this.isLocalIRI(id)) {
				const localActivity = await this.store.getActivity(id);
				if (localActivity) {
					return localActivity;
				}
				const localCached = await this.store.getObject(id);
				if (localCached) {
					return localCached;
				}
				return isAPObject(objectOrIRI) ? objectOrIRI : null;
			}
			// すでに DB にキャッシュされているオブジェクトならそれを返し、上書き保存しない (→ ADR-0053)
			const activity = await this.store.getActivity(id);
			if (activity) {
				return activity;
			}
			const cached = await this.store.getObject(id);
			if (cached) {
				return cached;
			}
		}
		object = objectOrIRI;
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
