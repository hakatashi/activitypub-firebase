/* eslint-disable private-props/no-use-outside, no-underscore-dangle */
import type {Firestore} from '@google-cloud/firestore';
// @ts-expect-error: Not typed
import IApexStore from 'activitypub-express/store/interface.js';
import firebase from 'firebase-admin';
import {DocumentData, Query} from 'firebase-admin/firestore';
import {logger} from 'firebase-functions/v2';
import {mapValues, sum} from 'lodash-es';
import {db} from './firebase.js';

const escapeFirestoreKey = (key: string) => (
	key
		.replaceAll(/%/g, '%25')
		.replaceAll(/\//g, '%2F')
		.replaceAll(/\./g, '%2E')
);

// const unescapeFirestoreKey = (key: string) => decodeURIComponent(key);

// Implements IApexStore:
// https://github.com/immers-space/activitypub-express/blob/master/store/interface.js

interface ObjectWithId {
	id: string,
	[key: string]: any,
}
export default class Store extends IApexStore {
	db: Firestore;

	constructor() {
		super();
		this.db = db;
	}

	async setup(initialUser?: any) {
		logger.info('setup');
		if (initialUser !== undefined) {
			await this.saveObject(initialUser);
		}
	}

	generateId() {
		return firebase.firestore().collection('objects').doc().id;
	}

	async getObject(id: string, includeMeta?: boolean) {
		logger.info({
			type: 'getObject',
			id,
			includeMeta,
		});
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

	async getObjects(field: string, value: any) {
		logger.info({
			type: 'getObjects',
			field,
			value,
		});
		const objectDocs = await this.db.collection('objects').where(field, '==', value).get();

		return objectDocs.docs.map((doc) => {
			const object = doc.data();
			// eslint-disable-next-line no-underscore-dangle, private-props/no-use-outside
			delete object._meta;
			return object;
		});
	}

	async getObjectsCount(field: string, value: any) {
		logger.info({
			type: 'countObjects',
			field,
			value,
		});
		const objectDocs = await this.db.collection('objects').where(field, '==', value).count().get();

		return objectDocs.data().count;
	}

	async saveObject(object: any) {
		await this.db.collection('objects').doc(escapeFirestoreKey(object.id)).set(object);
		return true;
	}

	private normalizeActivity(activity: DocumentData) {
		if (typeof activity?._meta?.collection === 'string') {
			activity._meta.collection = [activity._meta.collection];
		}
		return activity;
	}

	private getStreamQuery(baseQuery: Query<DocumentData>, limit: number | null, after: string | null, blockList?: string[], additionalQuery?: any[]) {
		let query = baseQuery;

		if (after) {
			query = query.where(firebase.firestore.FieldPath.documentId(), '>', after);
		}
		if (Array.isArray(blockList) && blockList.length > 0) {
			query = query.where('actor', 'not-in', blockList);
		}
		if (additionalQuery && additionalQuery.length > 0) {
			logger.error('getStream: additionalQuery is not supported yet', query);
		}

		query = query.orderBy(firebase.firestore.FieldPath.documentId(), 'desc');

		if (limit) {
			query = query.limit(limit);
		}

		return query;
	}

	/**
	 * Return a specific collection (stream of activitites), e.g. a user's inbox
	 * @param  {string} collectionId - _meta.collection identifier
	 * @param  {number} limit - max number of activities to return
	 * @param  {string} [after] - mongodb _id to begin querying after (i.e. last item of last page)
	 * @param  {string[]} [blockList] - list of ids of actors whose activities should be excluded
	 * @param  {object[]} [additionalQuery] - additional aggretation pipeline stages to include
	 * @returns {Promise<object[]>} - result
	 */
	async getStream(collectionId: string, limit: number | null, after: string | null, blockList?: string[], additionalQuery?: any[]) {
		logger.info({
			type: 'getStream',
			collectionId,
			limit,
			after,
			blockList,
			additionalQuery,
		});

		const streamsList = await Promise.all([
			this.getStreamQuery(
				this.db.collection('streams')
					.where('_meta.collection', '==', collectionId),
				limit, after, blockList, additionalQuery,
			).get(),
			this.getStreamQuery(
				this.db.collection('streams')
					.where('_meta.collection', 'array-contains', collectionId),
				limit, after, blockList, additionalQuery,
			).get(),
		]);

		return streamsList
			.map((streams) => (
				streams.docs.map((doc) => this.normalizeActivity(doc.data()))
			))
			.flat();
	}

	async getStreamCount(collectionId: string) {
		const counts = await Promise.all([
			this.db.collection('streams')
				.where('_meta.collection', '==', collectionId)
				.count()
				.get(),
			this.db.collection('streams')
				.where('_meta.collection', 'array-contains', collectionId)
				.count()
				.get(),
		]);
		return sum(counts.map((count) => count.data().count));
	}

	async getUserCount() {
		const count = await this.db.collection('objects').count().get();
		return count.data().count;
	}

	async updateObject(obj: ObjectWithId, actorId: string, fullReplace: boolean) {
		const objectDoc = this.db.collection('objects').doc(escapeFirestoreKey(obj.id));
		if (fullReplace) {
			await objectDoc.set(obj);
			await this.updateObjectCopies(obj);
			return obj;
		}
		await objectDoc.update(this.objectToUpdateDoc(obj));
		await this.updateObjectCopies(obj);
		return objectDoc.get().then((doc) => doc.data()!);
	}

	async getActivity(id: string, includeMeta?: boolean) {
		const activityDoc = await this.db.collection('streams').doc(escapeFirestoreKey(id)).get();

		if (!activityDoc.exists) {
			return undefined;
		}

		const activity = activityDoc.data()!;

		if (includeMeta !== true) {
			// eslint-disable-next-line no-underscore-dangle, private-props/no-use-outside
			delete activity._meta;
		}

		return this.normalizeActivity(activity);
	}

	async saveActivity(activity: ObjectWithId) {
		logger.info({type: 'saveActivity', activity});
		const activityRef = this.db.collection('streams').doc(escapeFirestoreKey(activity.id));
		let inserted: undefined | true = undefined;
		await this.db.runTransaction(async (transaction) => {
			const activityDoc = await transaction.get(activityRef);
			if (activityDoc.exists) {
				return;
			}
			transaction.set(activityRef, activity);
			inserted = true;
		});
		return inserted;
	}

	async removeActivity(activity: ObjectWithId, actorId: string) {
		await this.db.runTransaction(async (transaction) => {
			const matchedDocs = await transaction.get(
				this.db.collection('streams')
					.where('id', '==', activity.id)
					.where('actorId', '==', actorId),
			);
			matchedDocs.forEach((doc) => {
				transaction.delete(doc.ref);
			});
		});
	}

	async updateActivity(activity: ObjectWithId, fullReplace: boolean) {
		const activityRef = this.db.collection('streams').doc(escapeFirestoreKey(activity.id));
		if (fullReplace) {
			await activityRef.set(activity);
			await this.updateObjectCopies(activity);
			return activity;
		}
		await activityRef.update(this.objectToUpdateDoc(activity));
		await this.updateObjectCopies(activity);
		return activityRef.get().then((doc) => this.normalizeActivity(doc.data()!));
	}

	// eslint-disable-next-line max-params
	updateActivityMeta(activity: ObjectWithId, key: string, value: any, remove: boolean) {
		if (key.includes('.')) {
			throw new Error('updateActivityMeta: key must not include "."');
		}
		const activityRef = this.db.collection('streams').doc(escapeFirestoreKey(activity.id));
		return this.db.runTransaction(async (transaction) => {
			const activityDoc = await transaction.get(activityRef);
			if (!activityDoc.exists) {
				throw new Error('Error updating activity meta: not found');
			}
			const activityData = activityDoc.data()!;
			if (remove) {
				delete activityData._meta[key];
			} else {
				activityData._meta[key] = value;
			}
			transaction.update(activityRef, activityData);
			return this.normalizeActivity(activityData);
		});
	}

	// eslint-disable-next-line max-params
	async deliveryEnqueue(actorId: string, body: string, addresses: string | string[], signingKey: string) {
		if (!addresses || !addresses.length) {
			return false;
		}

		logger.info({
			type: 'deliveryEnqueue',
			actorId,
			addresses,
			signingKey,
			body,
		});

		const normalizedAddresses = Array.isArray(addresses) ? addresses : [addresses];

		// XXX: Debug only
		const normalizedBody = body.replaceAll('as:Public', 'https://www.w3.org/ns/activitystreams#Public');

		const batch = this.db.batch();
		const deliveryQueueRef = this.db.collection('deliveryQueue');
		const deliveries = [];
		for (const address of normalizedAddresses) {
			const delivery = {
				address,
				actorId,
				signingKey,
				body: normalizedBody,
				attempt: 0,
				after: new Date(),
			};
			deliveries.push(delivery);
			batch.set(deliveryQueueRef.doc(), delivery);
		}
		await batch.commit();

		logger.info({
			type: 'deliveryEnqueueResult',
			deliveries,
		});

		return true;
	}

	deliveryDequeue() {
		logger.info({type: 'deliveryDequeue'});

		return this.db.runTransaction(async (transaction) => {
			const matchedDocs = await transaction.get(
				this.db.collection('deliveryQueue')
					.where('after', '<=', new Date())
					.orderBy('after')
					.orderBy(firebase.firestore.FieldPath.documentId())
					.limit(1),
			);

			if (!matchedDocs.empty) {
				const doc = matchedDocs.docs[0];
				transaction.delete(doc.ref);
				const delivery = doc.data();
				logger.info({
					type: 'deliveryDequeueResult',
					delivery,
				});
				return {
					...delivery,
					after: delivery.after.toDate(),
				};
			}

			// if no deliveries available now, check for scheduled deliveries
			const next = await transaction.get(
				this.db.collection('deliveryQueue')
					.orderBy('after')
					.limit(1),
			);

			if (!next.empty) {
				return {waitUntil: next.docs[0].get('after').toDate()};
			}

			return null;
		});
	}

	async deliveryRequeue(delivery: {after: Date, attempt: number}) {
		const nextTime = delivery.after.getTime() + 10 ** delivery.attempt++;
		await this.db.collection('deliveryQueue').add({
			...delivery,
			after: new Date(nextTime),
		});
		return true;
	}

	private objectToUpdateDoc(object: ObjectWithId) {
		return mapValues(object, (value) => {
			if (value === null) {
				return firebase.firestore.FieldValue.delete();
			}
			return value;
		});
	}

	private async updateObjectCopies(object: ObjectWithId) {
		await this.db.runTransaction(async (transaction) => {
			const matchedDocs = await transaction.get(
				this.db.collection('streams')
					.where('object.id', '==', object.id),
			);
			matchedDocs.forEach((doc) => {
				const newObjectDict = mapValues(doc.get('object'), (value) => {
					if (value.id === object.id) {
						return object;
					}
					return value;
				});
				transaction.update(doc.ref, {object: newObjectDict});
			});
		});

		if (object._meta?.privateKey) {
			await this.db.runTransaction(async (transaction) => {
				const matchedDocs = await transaction.get(
					this.db.collection('deliveryQueue')
						.where('actorId', '==', object.id),
				);
				matchedDocs.forEach((doc) => {
					transaction.update(doc.ref, {signingKey: object._meta.privateKey});
				});
			});
		}
	}
}
