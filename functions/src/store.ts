import assert from 'node:assert';
import type { Firestore } from '@google-cloud/firestore';
// @ts-expect-error: Not typed
import IApexStore from 'activitypub-express/store/interface.js';
import firebase from 'firebase-admin';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { chunk, mapValues } from 'lodash-es';
import { db, escapeFirestoreKey } from './firebase.js';

// const unescapeFirestoreKey = (key: string) => decodeURIComponent(key);

// Firestore の `in` フィルタは1クエリにつき最大30件までしか指定できない。
export const FIRESTORE_IN_QUERY_LIMIT = 30;

// Implements IApexStore:
// https://github.com/immers-space/activitypub-express/blob/master/store/interface.js

interface ObjectWithId {
	id: string;
	[key: string]: any;
}

type DeliveryStatus = 'permanent_failure' | 'retrying' | 'success';

interface DeliveryResult {
	activityId: string;
	actorId: string;
	address: string;
	body: string;
	attempts: number;
	status: DeliveryStatus;
	statusCode?: number;
	error?: string;
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

		const object = objectDoc.data();
		assert(object !== undefined, 'object is undefined');

		if (includeMeta !== true) {
			delete object._meta;
		}

		return object;
	}

	// Extended by us
	async getObjects(ids: string[], includeMeta = false) {
		logger.info({
			type: 'getObjects',
			ids,
			includeMeta,
		});

		if (ids.length === 0) {
			return [];
		}

		const idChunks = chunk(ids.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT);
		const objectDocsChunks = await Promise.all(
			idChunks.map((idChunk) =>
				this.db
					.collection('objects')
					.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk)
					.get(),
			),
		);

		return objectDocsChunks.flatMap((objectDocs) =>
			objectDocs.docs.map((doc) => {
				const object = doc.data();
				if (includeMeta !== true) {
					delete object._meta;
				}
				return object;
			}),
		);
	}

	// Extended by us
	async getObjectsByFieldValue(field: string, value: any, includeMeta = false) {
		logger.info({
			type: 'getObjects',
			field,
			value,
		});
		const objectDocs = await this.db
			.collection('objects')
			.where(field, '==', value)
			.orderBy('published', 'desc')
			.get();

		return objectDocs.docs.map((doc) => {
			const object = doc.data();
			if (includeMeta !== true) {
				delete object._meta;
			}
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

	/**
	 * Return a specific collection (stream of activitites), e.g. a user's inbox
	 * @param  {string} collectionId - _meta.collection identifier
	 * @param  {number} limit - max number of activities to return
	 * @param  {string} [after] - mongodb _id to begin querying after (i.e. last item of last page)
	 * @param  {string[]} [blockList] - list of ids of actors whose activities should be excluded
	 * @param  {object[]} [additionalQuery] - additional aggretation pipeline stages to include
	 * @returns {Promise<object[]>} - result
	 */
	// eslint-disable-next-line max-params
	async getStream(
		collectionId: string,
		limit: number | null,
		after: string | null,
		blockList?: string[],
		additionalQuery?: any[],
	) {
		logger.info({
			type: 'getStream',
			collectionId,
			limit,
			after,
			blockList,
			additionalQuery,
		});

		let query = this.db
			.collection('streams')
			.where('_meta.collection', 'array-contains', collectionId);

		if (after) {
			// orderBy is descending, so "after" (the last item of the previous
			// page) means items that sort strictly lower than it.
			query = query.where(firebase.firestore.FieldPath.documentId(), '<', after);
		}
		if (Array.isArray(blockList) && blockList.length > 0) {
			query = query.where('actor', 'not-in', blockList);
		}
		if (additionalQuery && additionalQuery.length > 0) {
			for (const queryObject of additionalQuery) {
				for (const [key, value] of Object.entries(queryObject)) {
					if (key.startsWith('$')) {
						throw new Error('getStream: additionalQuery: $-prefixed keys are not supported yet');
					}
					if (typeof value === 'object' && value !== null) {
						throw new Error('getStream: additionalQuery: object values are not supported yet');
					}

					query = query.where(key, '==', value);
				}
			}
		}

		query = query.orderBy(firebase.firestore.FieldPath.documentId(), 'desc');

		if (limit) {
			query = query.limit(limit);
		}

		const streams = await query.get();

		// activitypub-express's buildCollectionPage uses `_id` (a MongoDB
		// convention) as the cursor for the next page, so we surface the
		// Firestore document ID under that key.
		return streams.docs.map((doc) => ({ ...doc.data(), _id: doc.id }));
	}

	async getStreamCount(collectionId: string) {
		const result = await this.db
			.collection('streams')
			.where('_meta.collection', 'array-contains', collectionId)
			.count()
			.get();
		return result.data().count;
	}

	async getUserCount() {
		const count = await this.db
			.collection('objects')
			.where('type', '==', 'Person')
			.orderBy('_meta.privateKey', 'desc') // Ensures that the private key exists
			.count()
			.get();
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
		return objectDoc.get().then((doc) => {
			const data = doc.data();
			assert(data !== undefined, 'data is undefined');
			return data;
		});
	}

	// Firestore は1クエリにつき array-contains を1つしか使えないため、`_meta.collection` と
	// `_meta.actorIds`/`_meta.objectIds` の両方を array-contains で絞り込むことはできない。
	// 対象アクターの IRI という選択性の高い方だけを Firestore に絞り込ませ、`_meta.collection`
	// への所属はアプリケーション側で判定する。
	//
	// 生の `object`/`actor` フィールドではなく denormalizations.ts が書き込む
	// `_meta.objectIds`/`_meta.actorIds` を見るのは、AS2 の `object`/`actor` が IRI 文字列・
	// Link・埋め込みオブジェクトのいずれにもなりうるため。Mastodon 以外の実装からの入力や
	// Undo の埋め込みオブジェクトでは、実際に埋め込みオブジェクトが入る(→ ADR-0020)。
	async findActivityByCollectionAndObjectId(
		collection: string,
		objectId: string,
		includeMeta?: boolean,
	) {
		logger.info({
			type: 'findActivityByCollectionAndObjectId',
			collection,
			objectId,
		});

		const streamDocs = await this.db
			.collection('streams')
			.where('_meta.objectIds', 'array-contains', objectId)
			.get();

		const activityDoc = streamDocs.docs.find((doc) =>
			(doc.get('_meta')?.collection as string[] | undefined)?.includes(collection),
		);
		if (!activityDoc) {
			return undefined;
		}

		const activity = activityDoc.data();
		if (includeMeta !== true) {
			delete activity._meta;
		}
		return activity;
	}

	async findActivityByCollectionAndActorId(
		collection: string,
		actorId: string,
		includeMeta?: boolean,
	) {
		logger.info({
			type: 'findActivityByCollectionAndActorId',
			collection,
			actorId,
		});

		const streamDocs = await this.db
			.collection('streams')
			.where('_meta.actorIds', 'array-contains', actorId)
			.get();

		const activityDoc = streamDocs.docs.find((doc) =>
			(doc.get('_meta')?.collection as string[] | undefined)?.includes(collection),
		);
		if (!activityDoc) {
			return undefined;
		}

		const activity = activityDoc.data();
		if (includeMeta !== true) {
			delete activity._meta;
		}
		return activity;
	}

	async getActivity(id: string, includeMeta?: boolean) {
		const activityDoc = await this.db.collection('streams').doc(escapeFirestoreKey(id)).get();

		if (!activityDoc.exists) {
			return undefined;
		}

		const activity = activityDoc.data();
		assert(activity !== undefined, 'activity is undefined');

		if (includeMeta !== true) {
			delete activity._meta;
		}

		return activity;
	}

	async saveActivity(activity: ObjectWithId) {
		logger.info({ type: 'saveActivity', activity });
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
				this.db
					.collection('streams')
					.where('id', '==', activity.id)
					.where('_meta.actorIds', 'array-contains', actorId),
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
		return activityRef.get().then((doc) => {
			const data = doc.data();
			assert(data !== undefined, 'data is undefined');
			return data;
		});
	}

	// _meta.collection を「アクティビティが所属するコレクションの集合」として扱う apex の
	// 前提(MongoDB 実装の $addToSet / $pull)に合わせ、配列への重複しない追加・単一値の
	// 除去として実装する (→ ADR-0017)。
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
			const activityData = activityDoc.data();
			assert(activityData !== undefined, 'activityData is undefined');
			activityData._meta ??= {};
			const current: any[] = Array.isArray(activityData._meta[key]) ? activityData._meta[key] : [];
			let updated = current;
			if (remove) {
				updated = current.filter((item) => item !== value);
			} else if (!current.includes(value)) {
				updated = [...current, value];
			}
			activityData._meta[key] = updated;
			transaction.update(activityRef, { [`_meta.${key}`]: updated });
			return activityData;
		});
	}

	// eslint-disable-next-line max-params
	async deliveryEnqueue(
		actorId: string,
		body: any,
		addresses: string | string[],
		_signingKey: string,
	) {
		if (!addresses || !addresses.length) {
			return false;
		}

		logger.info({
			type: 'deliveryEnqueue',
			actorId,
			addresses,
		});

		const normalizedAddresses = Array.isArray(addresses) ? addresses : [addresses];

		// 秘密鍵はタスクペイロードに載せない。ワーカー側で actorId から鍵を引く。
		await Promise.all(
			normalizedAddresses.map((address) =>
				getFunctions().taskQueue('deliveryTask').enqueue({ actorId, body, address }),
			),
		);

		logger.info({
			type: 'deliveryEnqueueResult',
			actorId,
			addresses: normalizedAddresses,
		});

		return true;
	}

	// Extended by us (ADR-0012)
	private deliveryDocId(activityId: string, address: string) {
		return escapeFirestoreKey(`${activityId} ${address}`);
	}

	// Extended by us (ADR-0012)
	async recordDeliveryResult({
		activityId,
		actorId,
		address,
		body,
		attempts,
		status,
		statusCode,
		error,
	}: DeliveryResult) {
		logger.info({
			type: 'recordDeliveryResult',
			activityId,
			actorId,
			address,
			attempts,
			status,
			statusCode,
		});

		await this.db
			.collection('deliveries')
			.doc(this.deliveryDocId(activityId, address))
			.set({
				activityId,
				actorId,
				inbox: address,
				body,
				attempts,
				status,
				statusCode: statusCode ?? null,
				error: error ?? null,
				updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
			});
	}

	// Extended by us (ADR-0012)
	async getFailedDeliveries() {
		const snapshot = await this.db
			.collection('deliveries')
			.where('status', 'in', ['permanent_failure', 'retrying'])
			.get();

		return snapshot.docs.map((doc) => doc.data());
	}

	// Extended by us (ADR-0012)
	async getDelivery(activityId: string, address: string) {
		const doc = await this.db
			.collection('deliveries')
			.doc(this.deliveryDocId(activityId, address))
			.get();
		return doc.exists ? doc.data() : undefined;
	}

	async getContext(documentUrl: string) {
		logger.info({ type: 'getContext', documentUrl });

		const contextDoc = await this.db
			.collection('contexts')
			.doc(escapeFirestoreKey(documentUrl))
			.get();
		if (contextDoc.exists) {
			const contextData = contextDoc.data();
			assert(contextData !== undefined, 'contextData is undefined');
			contextData.document = JSON.parse(contextData.document);
			return contextData;
		}

		return undefined;
	}

	async saveContext({
		contextUrl,
		documentUrl,
		document,
	}: {
		contextUrl: string;
		documentUrl: string;
		document: any;
	}) {
		logger.info({ type: 'saveContext', contextUrl, documentUrl, document });

		await this.db
			.collection('contexts')
			.doc(escapeFirestoreKey(documentUrl))
			.set(
				{
					contextUrl,
					documentUrl,
					document: typeof document === 'object' ? JSON.stringify(document) : document,
				},
				{ merge: true },
			);
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
				this.db.collection('streams').where('object.id', '==', object.id),
			);
			matchedDocs.forEach((doc) => {
				const newObjectDict = mapValues(doc.get('object'), (value) => {
					if (value.id === object.id) {
						return object;
					}
					return value;
				});
				transaction.update(doc.ref, { object: newObjectDict });
			});
		});
	}
}
