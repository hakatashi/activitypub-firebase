import assert from 'node:assert';
import type { Firestore } from '@google-cloud/firestore';
import type { APObject, ApexStore, SaveActivityResult } from '../apex/index.js';
import IApexStore from '../apex/store/interface.js';
import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { db, escapeFirestoreKey } from '../firebase.js';
import { getOrAssignMastodonIdInTransaction, toPublishedSortKey } from '../mastodonId.js';
import { metaIndexPath } from '../meta.js';
import { prepareProjectionUpdates } from '../projections/index.js';
import { Contexts, Objects, Streams } from '../schema.js';
import { toIdArray } from '../utils.js';
import { enqueueDeliveryTasks } from './deliveries.js';
import { objectToUpdateDoc, replaceKeepingMeta, updateObjectCopies } from './updates.js';

// apex が Store に要求する契約 (IApexStore) の Firestore 実装。apex から呼ばれないアプリ独自の
// クエリや操作はこのクラスに置かず、同じディレクトリの機能別のモジュールに関数として置く。
//
// IApexStore (apex/store/interface.ts) を継承しつつ ApexStore (apex が Store に要求する契約) を
// implements する (→ ADR-0022、ADR-0051)。deliveryDequeue/deliveryRequeue は override しておらず、
// IApexStore 由来の「呼ばれたら例外を投げる」実装のままになっている。
//
// これは意図的なスタブであり安全: apex 本体で deliveryDequeue/deliveryRequeue を呼ぶのは
// pub/federation.ts の runDelivery のみで、runDelivery は startDelivery 経由でしか
// 呼ばれない。startDelivery は `if (isDelivering || this.offlineMode) return` で
// offlineMode が真なら即 return し runDelivery を呼ばない。このプロジェクトの apex 初期化
// (apex.ts) は常に offlineMode: true で、配送は Store.deliveryEnqueue が Cloud Tasks へ直接
// enqueue することで行っている (→ ADR-0003)。deliveryEnqueue の override 自身も
// startDelivery/runDelivery を呼んでいないため、deliveryDequeue/deliveryRequeue が実行時に
// 呼ばれる経路は存在しない (→ Issue #84 で確認)。
export default class Store extends IApexStore implements ApexStore {
	db: Firestore;

	constructor() {
		super();
		this.db = db;
	}

	override async setup(initialUser?: APObject) {
		logger.info('setup');
		if (initialUser !== undefined) {
			await this.saveObject(initialUser);
		}
	}

	override generateId() {
		return Objects.doc().id;
	}

	override async getObject(id: string, includeMeta?: boolean) {
		logger.info({
			type: 'getObject',
			id,
			includeMeta,
		});
		const objectDoc = await Objects.doc(escapeFirestoreKey(id)).get();

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

	override async saveObject(object: APObject) {
		const objectId = object.id ?? this.generateId();
		const objectWithId = object.id ? object : { ...object, id: objectId };
		const publishedKey = toPublishedSortKey(objectWithId.published);
		if (publishedKey !== undefined) {
			objectWithId._meta = { ...objectWithId._meta, published: publishedKey };
		}
		if (objectWithId.inReplyTo !== undefined) {
			const inReplyTo = toIdArray(objectWithId.inReplyTo);
			if (inReplyTo.length > 0) {
				objectWithId.inReplyTo = inReplyTo;
			}
		}
		const docRef = Objects.doc(escapeFirestoreKey(objectId));
		await this.db.runTransaction(async (transaction) => {
			const doc = await transaction.get(docRef);
			if (doc.exists) {
				const existingData = doc.data();
				// 既存の _meta (非正規化カウンタ等) がある場合、新しい object に _meta が含まれていなければ
				// 引き継ぎ、含まれている場合はマージして既存のカウンタを保護する (→ ADR-0053)。
				if (existingData?._meta !== undefined) {
					objectWithId._meta = {
						...existingData._meta,
						...objectWithId._meta,
					};
				}
			}
			// 新規・既存を問わず Mastodon ID のマッピングを保証する (→ ADR-0058)。
			// 読み取りを伴うため、トランザクション内の書き込みより前に呼ぶ。
			await getOrAssignMastodonIdInTransaction(transaction, objectId, objectWithId.published);
			transaction.set(docRef, objectWithId);
		});
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
	// blockList は Firestore の not-in ではなく取得後にアプリケーション側でフィルタする(→ ADR-0029)。
	// oxlint-disable-next-line max-params
	override async getStream(
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

		let query = Streams.where('_meta.collection', 'array-contains', collectionId);

		if (after) {
			// orderBy is descending, so "after" (the last item of the previous
			// page) means items that sort strictly lower than it.
			query = query.where(firebase.firestore.FieldPath.documentId(), '<', after);
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

		const blockSet = new Set(blockList);
		const docs =
			blockSet.size > 0
				? streams.docs.filter(
						(doc) => !toIdArray(doc.get('actor')).some((actor) => blockSet.has(actor)),
					)
				: streams.docs;

		// activitypub-express's buildCollectionPage uses `_id` (a MongoDB
		// convention) as the cursor for the next page, so we surface the
		// Firestore document ID under that key.
		return docs.map((doc) => ({ ...doc.data(), _id: doc.id }));
	}

	override async getStreamCount(collectionId: string) {
		const result = await Streams.where('_meta.collection', 'array-contains', collectionId)
			.count()
			.get();
		return result.data().count;
	}

	override async getUserCount() {
		const count = await Objects.where('type', '==', 'Person')
			.orderBy('_meta.privateKey', 'desc') // Ensures that the private key exists
			.count()
			.get();
		return count.data().count;
	}

	override async updateObject(obj: APObject, actorId: string | null, fullReplace: boolean) {
		const objectDoc = Objects.doc(escapeFirestoreKey(obj.id));
		const publishedKey = toPublishedSortKey(obj.published);
		if (fullReplace) {
			await replaceKeepingMeta(
				objectDoc,
				publishedKey === undefined
					? obj
					: { ...obj, _meta: { ...obj._meta, published: publishedKey } },
			);
			await updateObjectCopies(obj);
			return obj;
		}
		await objectDoc.update({
			...objectToUpdateDoc(obj),
			// `_meta` はドット記法で更新し、既存のカウンタなどを消さない。
			...(publishedKey === undefined ? {} : { '_meta.published': publishedKey }),
		});
		await updateObjectCopies(obj);
		return objectDoc.get().then((doc) => {
			const data = doc.data();
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
	override findActivityByCollectionAndObjectId(
		collection: string,
		objectId: string,
		includeMeta?: boolean,
	) {
		logger.info({
			type: 'findActivityByCollectionAndObjectId',
			collection,
			objectId,
		});

		return this.findActivityByCollectionAndIndex('objects', collection, objectId, includeMeta);
	}

	override findActivityByCollectionAndActorId(
		collection: string,
		actorId: string,
		includeMeta?: boolean,
	) {
		logger.info({
			type: 'findActivityByCollectionAndActorId',
			collection,
			actorId,
		});

		return this.findActivityByCollectionAndIndex('actors', collection, actorId, includeMeta);
	}

	// oxlint-disable-next-line max-params
	private async findActivityByCollectionAndIndex(
		field: 'actors' | 'objects',
		collection: string,
		id: string,
		includeMeta?: boolean,
	) {
		const streamDocs = await Streams.where(
			metaIndexPath('collections', escapeFirestoreKey(collection)),
			'==',
			true,
		)
			.where(metaIndexPath(field, escapeFirestoreKey(id)), '==', true)
			.limit(1)
			.get();

		const activity = streamDocs.docs[0]?.data();
		if (activity === undefined) {
			return undefined;
		}

		if (includeMeta !== true) {
			delete activity._meta;
		}
		return activity;
	}

	override async getActivity(id: string, includeMeta?: boolean) {
		const activityDoc = await Streams.doc(escapeFirestoreKey(id)).get();

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

	override saveActivity(activity: APObject): Promise<SaveActivityResult> {
		const activityId = activity.id ?? this.generateId();
		const activityWithId = activity.id ? activity : { ...activity, id: activityId };
		logger.info({ type: 'saveActivity', activity: activityWithId });
		const activityRef = Streams.doc(escapeFirestoreKey(activityId));
		return this.db.runTransaction(async (transaction): Promise<SaveActivityResult> => {
			const activityDoc = await transaction.get(activityRef);
			const existingData = activityDoc.data();

			let result: SaveActivityResult;
			let write: (() => void) | undefined;
			if (existingData === undefined) {
				result = { isNew: true, activity: activityWithId };
				write = () => transaction.set(activityRef, activityWithId);
			} else {
				const existingCollections: string[] = Array.isArray(existingData._meta?.collection)
					? existingData._meta.collection
					: [];
				const incomingCollections: string[] = Array.isArray(activity._meta?.collection)
					? activity._meta.collection
					: [];

				const newCollections = incomingCollections.filter(
					(collection) => !existingCollections.includes(collection),
				);

				if (newCollections.length > 0) {
					const updatedCollections = [...existingCollections, ...newCollections];
					result = {
						isNew: 'new collection',
						activity: {
							...existingData,
							_meta: {
								...existingData._meta,
								collection: updatedCollections,
							},
						},
					};
					write = () =>
						transaction.update(activityRef, {
							'_meta.collection': updatedCollections,
						});
				} else {
					result = { isNew: false, activity: existingData };
				}
			}

			// フォロー関係などの射影も同じトランザクションで更新する (→ ADR-0082, ADR-0084)。
			const commitProjection =
				write === undefined
					? undefined
					: await prepareProjectionUpdates(transaction, existingData, result.activity);
			// 新規・既存を問わず Mastodon ID のマッピングを保証する (→ ADR-0058)。
			// 読み取りを伴うため、トランザクション内の書き込みより前に呼ぶ。
			const mastodonId = await getOrAssignMastodonIdInTransaction(
				transaction,
				activityId,
				activityWithId.published,
			);
			write?.();
			commitProjection?.(mastodonId);
			return result;
		});
	}

	// MongoDB 実装の `deleteMany({ id: activity.id, actor: actorId })` に対応する。
	// ドキュメント ID がアクティビティの IRI そのものなので id での検索はクエリを要さず、
	// actor の照合も取得済みドキュメントに対する判定なので生の `actor` を toIdArray で解決する
	// (非正規化インデックスの遅延に依存させない → ADR-0021)。
	override async removeActivity(activity: APObject, actorId: string) {
		const activityRef = Streams.doc(escapeFirestoreKey(activity.id));
		await this.db.runTransaction(async (transaction) => {
			const activityDoc = await transaction.get(activityRef);
			if (!activityDoc.exists) {
				return;
			}
			if (!toIdArray(activityDoc.get('actor')).includes(actorId)) {
				return;
			}
			// フォロー関係などの射影も同じトランザクションで更新する (→ ADR-0082, ADR-0084)。
			const commitProjection = await prepareProjectionUpdates(
				transaction,
				activityDoc.data(),
				undefined,
			);
			transaction.delete(activityRef);
			commitProjection?.();
		});
	}

	override async updateActivity(activity: APObject, fullReplace: boolean) {
		const activityRef = Streams.doc(escapeFirestoreKey(activity.id));
		if (fullReplace) {
			await replaceKeepingMeta(activityRef, activity);
			await updateObjectCopies(activity);
			return activity;
		}
		await activityRef.update(objectToUpdateDoc(activity));
		await updateObjectCopies(activity);
		return activityRef.get().then((doc) => {
			const data = doc.data();
			assert(data !== undefined, 'data is undefined');
			return data;
		});
	}

	// _meta.collection を「アクティビティが所属するコレクションの集合」として扱う apex の
	// 前提(MongoDB 実装の $addToSet / $pull)に合わせ、配列への重複しない追加・単一値の
	// 除去として実装する (→ ADR-0017)。
	// なお、シグネチャとしては任意の key を受け取れるようになっているが、apex 本体の実装を含め
	// 実際には key === 'collection' (_meta.collection) 専用としてのみ呼び出されている。
	// oxlint-disable-next-line max-params
	override updateActivityMeta(activity: APObject, key: string, value: unknown, remove: boolean) {
		if (key.includes('.')) {
			throw new Error('updateActivityMeta: key must not include "."');
		}
		const activityRef = Streams.doc(escapeFirestoreKey(activity.id));
		return this.db.runTransaction(async (transaction) => {
			const activityDoc = await transaction.get(activityRef);
			if (!activityDoc.exists) {
				throw new Error('Error updating activity meta: not found');
			}
			const activityData = activityDoc.data();
			assert(activityData !== undefined, 'activityData is undefined');
			const currentRaw = activityData._meta?.[key];
			const current = Array.isArray(currentRaw) ? currentRaw : [];
			let updated = current;
			if (remove) {
				updated = current.filter((item) => item !== value);
			} else if (!current.includes(value)) {
				updated = [...current, value];
			}
			const updatedActivity = { ...activityData, _meta: { ...activityData._meta, [key]: updated } };
			// フォロー関係などの射影も同じトランザクションで更新する (→ ADR-0082, ADR-0084)。
			const commitProjection = await prepareProjectionUpdates(
				transaction,
				activityData,
				updatedActivity,
			);
			transaction.update(activityRef, { [`_meta.${key}`]: updated });
			commitProjection?.();
			return updatedActivity;
		});
	}

	// oxlint-disable-next-line max-params
	override async deliveryEnqueue(
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

		await enqueueDeliveryTasks(actorId, body, normalizedAddresses);

		logger.info({
			type: 'deliveryEnqueueResult',
			actorId,
			addresses: normalizedAddresses,
		});

		return true;
	}

	override async getContext(documentUrl: string) {
		logger.info({ type: 'getContext', documentUrl });

		const contextDoc = await Contexts.doc(escapeFirestoreKey(documentUrl)).get();
		if (contextDoc.exists) {
			const contextData = contextDoc.data();
			assert(contextData !== undefined, 'contextData is undefined');
			const parsedDocument: unknown = JSON.parse(contextData.document);
			return { ...contextData, document: parsedDocument };
		}

		return undefined;
	}

	override async saveContext({
		contextUrl,
		documentUrl,
		document,
	}: Parameters<ApexStore['saveContext']>[0]) {
		logger.info({ type: 'saveContext', contextUrl, documentUrl, document });

		await Contexts.doc(escapeFirestoreKey(documentUrl)).set(
			{
				contextUrl,
				documentUrl,
				document: typeof document === 'string' ? document : JSON.stringify(document),
			},
			{ merge: true },
		);
	}
}
