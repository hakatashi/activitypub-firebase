import type {Firestore} from '@google-cloud/firestore';
// @ts-expect-error: Not typed
import * as IApexStore from 'activitypub-express/store/interface';
import * as firebase from 'firebase-admin';
import {logger} from 'firebase-functions/v1';

firebase.initializeApp();

const escapeFirestoreKey = (key: string) => (
	key
		.replaceAll(/%/g, '%25')
		.replaceAll(/\//g, '%2F')
		.replaceAll(/\./g, '%2E')
);

// const unescapeFirestoreKey = (key: string) => decodeURIComponent(key);

// Implements IApexStore:
// https://github.com/immers-space/activitypub-express/blob/master/store/interface.js
export default class Store extends IApexStore {
	db: Firestore;

	constructor() {
		super();
		this.db = firebase.firestore();
	}

	async setup(initialUser?: any) {
		logger.info('setup');
		if (initialUser !== undefined) {
			await this.saveObject(initialUser);
		}
	}

	async getObject(id: string, includeMeta?: boolean) {
		logger.info('getObject', id);
		const objectDoc = await this.db.collection('objects').doc(escapeFirestoreKey(id)).get();

		if (!objectDoc.exists) {
			return undefined;
		}

		const object = objectDoc.data()!;

		if (includeMeta !== true) {
			// eslint-disable-next-line no-underscore-dangle, private-props/no-use-outside
			delete object._meta;
		}

		return object;
	}

	async saveObject(object: any) {
		logger.info('saveObject', object.id);
		await this.db.collection('objects').doc(escapeFirestoreKey(object.id)).set(object);
		return true;
	}

	/**
	 * Return a specific collection (stream of activitites), e.g. a user's inbox
	 * @param  {string} collectionId - _meta.collection identifier
	 * @param  {number} limit - max number of activities to return
	 * @param  {string} [after] - mongodb _id to begin querying after (i.e. last item of last page)
	 * @param  {string[]} [blockList] - list of ids of actors whose activities should be excluded
	 * @param  {object[]} [query] - additional aggretation pipeline stages to include
	 * @returns {Promise<object[]>} - result
	 */
	async getStream(collectionId: string, limit: number | null, after: string | null, blockList?: string[], additionalQuery?: any[]) {
		logger.info('getStream', collectionId, limit, after, blockList, additionalQuery);
		let query = this.db.collection('streams')
			.where('_meta.collection', '==', collectionId);

		if (after) {
			query = query.where('_id', '>', after);
		}
		if (Array.isArray(blockList) && blockList.length > 0) {
			query = query.where('actor', 'not-in', blockList);
		}
		if (additionalQuery && additionalQuery.length > 0) {
			logger.error('getStream: additionalQuery is not supported yet', query);
		}

		query = query.orderBy('_id', 'desc');

		if (limit) {
			query = query.limit(limit);
		}

		const streams = await query.get();

		return streams.docs.map((doc) => doc.data());
	}

	async getStreamCount(collectionId: string) {
		const count = await this.db.collection('streams')
			.where('_meta.collection', '==', collectionId)
			.count()
			.get();
		return count.data().count;
	}
}
