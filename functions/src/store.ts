import assert from 'node:assert';
import type { Firestore } from '@google-cloud/firestore';
import type { APObject, ApexStore, DeliveryQueueRecord, DeliveryRecord } from 'activitypub-express';
import firebase from 'firebase-admin';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { chunk, isEqual, mapValues } from 'lodash-es';
import { db, escapeFirestoreKey } from './firebase.js';
import { metaIndexPath } from './meta.js';
import { toIdArray } from './utils.js';

// const unescapeFirestoreKey = (key: string) => decodeURIComponent(key);

// Firestore の `in` フィルタは1クエリにつき最大30件までしか指定できない。
export const FIRESTORE_IN_QUERY_LIMIT = 30;

// Implements ApexStore (functions/types/activitypub-express.d.ts):
// https://github.com/immers-space/activitypub-express/blob/master/store/interface.js
export default class Store implements ApexStore {
	db: Firestore;

	constructor() {
		this.db = db;
	}

	async setup(initialUser?: APObject) {
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

		const object = objectDoc.data() as APObject | undefined;
		assert(object !== undefined, 'object is undefined');

		if (includeMeta !== true) {
			delete object._meta;
		}

		return object;
	}

	// Extended by us
	async getObjects(ids: string[], includeMeta = false): Promise<APObject[]> {
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
				const object = doc.data() as APObject;
				if (includeMeta !== true) {
					delete object._meta;
				}
				return object;
			}),
		);
	}

	// Extended by us
	async getObjectsByFieldValue(
		field: string,
		value: unknown,
		includeMeta = false,
	): Promise<APObject[]> {
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
			const object = doc.data() as APObject;
			if (includeMeta !== true) {
				delete object._meta;
			}
			return object;
		});
	}

	async getObjectsCount(field: string, value: unknown) {
		logger.info({
			type: 'countObjects',
			field,
			value,
		});
		const objectDocs = await this.db.collection('objects').where(field, '==', value).count().get();

		return objectDocs.data().count;
	}

	async saveObject(object: APObject) {
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
		after?: string | null,
		blockList?: string[],
		additionalQuery?: Record<string, unknown>[],
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
		return streams.docs.map((doc) => ({ ...(doc.data() as APObject), _id: doc.id }));
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

	async updateObject(obj: APObject, actorId: string | null, fullReplace: boolean) {
		const objectDoc = this.db.collection('objects').doc(escapeFirestoreKey(obj.id));
		if (fullReplace) {
			await objectDoc.set(obj);
			await this.updateObjectCopies(obj);
			return obj;
		}
		await objectDoc.update(this.objectToUpdateDoc(obj));
		await this.updateObjectCopies(obj);
		return objectDoc.get().then((doc) => {
			const data = doc.data() as APObject | undefined;
			assert(data !== undefined, 'data is undefined');
			return data;
		});
	}

	// denormalizations.ts が書き込む map 形式のインデックス `_meta.index.*` を等価条件で引く
	// (→ ADR-0021)。等価条件どうしなら Firestore の array-contains 1個制限を受けないため、
	// コレクションへの所属と対象 IRI の両方を Firestore 側で絞り込める。
	//
	// 生の `object`/`actor` フィールドを直接引かないのは、AS2 の `object`/`actor` が IRI 文字列・
	// Link・埋め込みオブジェクトのいずれにもなりうるため。Mastodon 以外の実装からの入力や
	// Undo の埋め込みオブジェクトでは、実際に埋め込みオブジェクトが入る(→ ADR-0020)。
	findActivityByCollectionAndObjectId(collection: string, objectId: string, includeMeta?: boolean) {
		logger.info({
			type: 'findActivityByCollectionAndObjectId',
			collection,
			objectId,
		});

		return this.findActivityByCollectionAndIndex('objects', collection, objectId, includeMeta);
	}

	findActivityByCollectionAndActorId(collection: string, actorId: string, includeMeta?: boolean) {
		logger.info({
			type: 'findActivityByCollectionAndActorId',
			collection,
			actorId,
		});

		return this.findActivityByCollectionAndIndex('actors', collection, actorId, includeMeta);
	}

	// eslint-disable-next-line max-params
	private async findActivityByCollectionAndIndex(
		field: 'actors' | 'objects',
		collection: string,
		id: string,
		includeMeta?: boolean,
	) {
		const streamDocs = await this.db
			.collection('streams')
			.where(metaIndexPath('collections', collection), '==', true)
			.where(metaIndexPath(field, id), '==', true)
			.limit(1)
			.get();

		const activity = streamDocs.docs[0]?.data() as APObject | undefined;
		if (activity === undefined) {
			return undefined;
		}

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

		const activity = activityDoc.data() as APObject | undefined;
		assert(activity !== undefined, 'activity is undefined');

		if (includeMeta !== true) {
			delete activity._meta;
		}

		return activity;
	}

	async saveActivity(activity: APObject) {
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

	// MongoDB 実装の `deleteMany({ id: activity.id, actor: actorId })` に対応する。
	// ドキュメント ID がアクティビティの IRI そのものなので id での検索はクエリを要さず、
	// actor の照合も取得済みドキュメントに対する判定なので生の `actor` を toIdArray で解決する
	// (非正規化インデックスの遅延に依存させない → ADR-0021)。
	async removeActivity(activity: APObject, actorId: string) {
		const activityRef = this.db.collection('streams').doc(escapeFirestoreKey(activity.id));
		await this.db.runTransaction(async (transaction) => {
			const activityDoc = await transaction.get(activityRef);
			if (!activityDoc.exists) {
				return;
			}
			if (!toIdArray(activityDoc.get('actor')).includes(actorId)) {
				return;
			}
			transaction.delete(activityRef);
		});
	}

	async updateActivity(activity: APObject, fullReplace: boolean) {
		const activityRef = this.db.collection('streams').doc(escapeFirestoreKey(activity.id));
		if (fullReplace) {
			await activityRef.set(activity);
			await this.updateObjectCopies(activity);
			return activity;
		}
		await activityRef.update(this.objectToUpdateDoc(activity));
		await this.updateObjectCopies(activity);
		return activityRef.get().then((doc) => {
			const data = doc.data() as APObject | undefined;
			assert(data !== undefined, 'data is undefined');
			return data;
		});
	}

	// _meta.collection を「アクティビティが所属するコレクションの集合」として扱う apex の
	// 前提(MongoDB 実装の $addToSet / $pull)に合わせ、配列への重複しない追加・単一値の
	// 除去として実装する (→ ADR-0017)。
	// なお、シグネチャとしては任意の key を受け取れるようになっているが、apex 本体の実装を含め
	// 実際には key === 'collection' (_meta.collection) 専用としてのみ呼び出されている。
	// eslint-disable-next-line max-params
	updateActivityMeta(activity: APObject, key: string, value: unknown, remove: boolean) {
		if (key.includes('.')) {
			throw new Error('updateActivityMeta: key must not include "."');
		}
		const activityRef = this.db.collection('streams').doc(escapeFirestoreKey(activity.id));
		return this.db.runTransaction(async (transaction) => {
			const activityDoc = await transaction.get(activityRef);
			if (!activityDoc.exists) {
				throw new Error('Error updating activity meta: not found');
			}
			const activityData = activityDoc.data() as APObject | undefined;
			assert(activityData !== undefined, 'activityData is undefined');
			const meta = (activityData._meta as Record<string, unknown[]> | undefined) ?? {};
			const current = Array.isArray(meta[key]) ? meta[key] : [];
			let updated = current;
			if (remove) {
				updated = current.filter((item) => item !== value);
			} else if (!current.includes(value)) {
				updated = [...current, value];
			}
			meta[key] = updated;
			activityData._meta = meta;
			transaction.update(activityRef, { [`_meta.${key}`]: updated });
			return activityData;
		});
	}

	// eslint-disable-next-line max-params
	async deliveryEnqueue(
		actorId: string,
		body: string,
		addresses: string | string[],
		_signingKey: string | undefined,
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
	}: Parameters<ApexStore['recordDeliveryResult']>[0]) {
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

		return snapshot.docs.map((doc) => doc.data() as DeliveryRecord);
	}

	// Extended by us (ADR-0012)
	async getDelivery(activityId: string, address: string) {
		const doc = await this.db
			.collection('deliveries')
			.doc(this.deliveryDocId(activityId, address))
			.get();
		return doc.exists ? (doc.data() as DeliveryRecord) : undefined;
	}

	async getContext(documentUrl: string) {
		logger.info({ type: 'getContext', documentUrl });

		const contextDoc = await this.db
			.collection('contexts')
			.doc(escapeFirestoreKey(documentUrl))
			.get();
		if (contextDoc.exists) {
			const contextData = contextDoc.data() as
				| { contextUrl: string | null; documentUrl: string; document: string }
				| undefined;
			assert(contextData !== undefined, 'contextData is undefined');
			return { ...contextData, document: JSON.parse(contextData.document) as unknown };
		}

		return undefined;
	}

	async saveContext({
		contextUrl,
		documentUrl,
		document,
	}: Parameters<ApexStore['saveContext']>[0]) {
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

	private objectToUpdateDoc(object: APObject) {
		return mapValues(object, (value) => {
			if (value === null) {
				return firebase.firestore.FieldValue.delete();
			}
			return value;
		});
	}

	// `streams` に埋め込まれている古いコピーを新しい内容へ差し替える。
	// `streams.object` は常に配列なので、ドット記法(`where('object.id', '==', ...)`)では
	// 引けない。denormalizations.ts が書き込む map 形式のインデックスを使う(→ ADR-0021)。
	//
	// 置き換えるのは MongoDB 実装の arrayFilters(`{ 'element.id': object.id }`)と同じく
	// `id` が一致する埋め込みオブジェクトの要素だけで、IRI 文字列の要素はそのまま残す。
	// MongoDB 実装は配送キューの署名鍵も更新するが、こちらは配送時に actor を読み直すため不要。
	private async updateObjectCopies(object: APObject) {
		const replaceCopy = (value: unknown) => {
			if (
				typeof value === 'object' &&
				value !== null &&
				(value as { id?: unknown }).id === object.id
			) {
				return object;
			}
			return value;
		};

		await this.db.runTransaction(async (transaction) => {
			const matchedDocs = await transaction.get(
				this.db.collection('streams').where(metaIndexPath('objects', object.id), '==', true),
			);
			matchedDocs.forEach((doc) => {
				const rawObject = doc.get('object') as unknown;
				// 配列を配列のまま保つ(lodash の mapValues は配列を数値キーのマップに壊す)。
				const newObject = Array.isArray(rawObject)
					? rawObject.map(replaceCopy)
					: replaceCopy(rawObject);
				// IRI 文字列で参照しているだけのドキュメントには書き込まない
				// (無意味な書き込みで onStreamWritten を再発火させない)。
				if (isEqual(rawObject, newObject)) {
					return;
				}
				transaction.update(doc.ref, { object: newObject });
			});
		});
	}

	// apex 組み込みの配送キュー用メソッド。このプロジェクトでは配送を Cloud Tasks 経由で行い
	// (deliveryEnqueue 参照)、apex.offlineMode = true により apex 自身の配送ループ
	// (pub/federation.js runDelivery)が動かないため呼ばれることはない。
	// → Issue #84 で未実装のまま残っていることを追跡する。
	deliveryDequeue(): never {
		throw new Error('Not implemented: delivery is handled via Cloud Tasks (ADR-0003)');
	}

	deliveryRequeue(_delivery: DeliveryQueueRecord): never {
		throw new Error('Not implemented: delivery is handled via Cloud Tasks (ADR-0003)');
	}
}
