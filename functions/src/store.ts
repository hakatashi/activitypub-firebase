/* eslint-disable private-props/no-use-outside, no-underscore-dangle */
import type {Firestore} from '@google-cloud/firestore';
// @ts-expect-error: Not typed
import IApexStore from 'activitypub-express/store/interface';
import firebase from 'firebase-admin';
import {logger} from 'firebase-functions/v2';
import {mapValues} from 'lodash';

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

interface ObjectWithId {
	id: string,
	[key: string]: any,
}
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

	generateId() {
		return firebase.firestore().collection('objects').doc().id;
	}

	async getObject(id: string, includeMeta?: boolean) {
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
		await this.db.collection('objects').doc(escapeFirestoreKey(object.id)).set(object);
		return true;
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

		return activity;
	}

	async saveActivity(activity: ObjectWithId) {
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
		return activityRef.get().then((doc) => doc.data()!);
	}

	// eslint-disable-next-line max-params
	async updateActivityMeta(activity: ObjectWithId, key: string, value: any, remove: boolean) {
		if (key.includes('.')) {
			throw new Error('updateActivityMeta: key must not include "."');
		}
		const activityRef = this.db.collection('streams').doc(escapeFirestoreKey(activity.id));
		const result = await activityRef.update({
			[`_meta.${key}`]: remove ? firebase.firestore.FieldValue.delete() : value,
		});
		if (!result.writeTime) {
			throw new Error('Error updating activity meta: not found');
		}
		// FIXME: This is not atomic
		return activityRef.get().then((doc) => doc.data()!);
	}

	// eslint-disable-next-line max-params
	async deliveryEnqueue(actorId: string, body: any, addresses: string | string[], signingKey: string) {
		if (!addresses || !addresses.length) {
			return false;
		}

		const normalizedAddresses = Array.isArray(addresses) ? addresses : [addresses];

		const batch = this.db.batch();
		const deliveryQueueRef = this.db.collection('deliveryQueue');
		for (const address of normalizedAddresses) {
			batch.set(deliveryQueueRef.doc(), {
				address,
				actorId,
				signingKey,
				body,
				attempt: 0,
				after: new Date(),
			});
		}
		await batch.commit();

		return true;
	}

	deliveryDequeue() {
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
