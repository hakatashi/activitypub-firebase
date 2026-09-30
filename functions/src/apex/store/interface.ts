import type { APObject } from '../types.js';

// saveActivity の戻り値の isNew:
//   true             - このサーバーが初めて見る activity
//   'new collection' - 既知の activity が新しいコレクション (inbox) に届いた
//   false            - 同じコレクションへの重複配送
export type SaveActivityStatus = true | 'new collection' | false;

export interface SaveActivityResult {
	isNew: SaveActivityStatus;
	activity?: APObject;
}

export interface ContextRecord {
	contextUrl: string | null;
	documentUrl: string;
	document: unknown;
}

export interface DeliveryQueueRecord {
	address: string;
	actorId: string;
	signingKey: string;
	body: string;
	attempt: number;
	after: Date;
}

// apex が Store 実装に要求する契約
export interface ApexStore {
	setup(initialUser?: APObject): Promise<void>;
	generateId(): string;
	getObject(id: string, includeMeta?: boolean): Promise<APObject | undefined>;
	saveObject(object: APObject): Promise<boolean>;
	getActivity(id: string, includeMeta?: boolean): Promise<APObject | undefined>;
	findActivityByCollectionAndObjectId(
		collection: string,
		objectId: string,
		includeMeta?: boolean,
	): Promise<APObject | undefined>;
	findActivityByCollectionAndActorId(
		collection: string,
		actorId: string,
		includeMeta?: boolean,
	): Promise<APObject | undefined>;
	/**
	 * Return a specific collection (stream of activitites), e.g. a user's inbox
	 * @param collectionId - collection identifier
	 * @param limit - max number of activities to return (null for all)
	 * @param after - id to begin querying after (i.e. last item of last page)
	 * @param blockList - list of ids of actors whose activities should be excluded
	 * @param additionalQuery - additional query/aggregation
	 */
	getStream(
		collectionId: string,
		limit: number | null,
		after?: string | null,
		blockList?: string[],
		additionalQuery?: Record<string, unknown>[],
	): Promise<(APObject & { _id: string })[]>;
	getStreamCount(collectionId: string): Promise<number>;
	getContext(documentUrl: string): Promise<ContextRecord | undefined>;
	getUserCount(): Promise<number>;
	saveContext(context: ContextRecord): Promise<void>;
	/**
	 * Save an activity and add to collections specified in _meta.collection.
	 * Resolves with an object indicating whether the activity is newly created (true),
	 * added to a new collection ('new collection'), or a duplicate delivery (false).
	 */
	saveActivity(activity: APObject): Promise<SaveActivityResult>;
	removeActivity(activity: APObject, actorId: string): Promise<void>;
	updateActivity(activity: Partial<APObject>, fullReplace: boolean): Promise<APObject>;
	updateActivityMeta(
		activity: APObject,
		key: string,
		value: unknown,
		remove?: boolean,
	): Promise<APObject>;
	updateObject(obj: APObject, actorId: string | null, fullReplace: boolean): Promise<APObject>;
	deliveryDequeue(): Promise<DeliveryQueueRecord | { waitUntil: Date } | null>;
	deliveryEnqueue(
		actorId: string,
		body: string,
		addresses: string | string[],
		signingKey: string | undefined,
	): Promise<boolean>;
	deliveryRequeue(delivery: DeliveryQueueRecord): Promise<boolean>;
}

const notImplemented = () => new Error('Not implemented');

// 上流互換の基底クラス。未実装のメソッドは呼ばれた時点で例外を投げる。
// 実装漏れをコンパイル時に検出したい Store は、これを継承したうえで ApexStore を implements する。
export default class IApexStore implements ApexStore {
	setup(_initialUser?: APObject): Promise<void> {
		throw notImplemented();
	}

	getObject(_id: string, _includeMeta?: boolean): Promise<APObject | undefined> {
		throw notImplemented();
	}

	saveObject(_object: APObject): Promise<boolean> {
		throw notImplemented();
	}

	getActivity(_id: string, _includeMeta?: boolean): Promise<APObject | undefined> {
		throw notImplemented();
	}

	findActivityByCollectionAndObjectId(
		_collection: string,
		_objectId: string,
		_includeMeta?: boolean,
	): Promise<APObject | undefined> {
		throw notImplemented();
	}

	findActivityByCollectionAndActorId(
		_collection: string,
		_actorId: string,
		_includeMeta?: boolean,
	): Promise<APObject | undefined> {
		throw notImplemented();
	}

	getStream(
		_collectionId: string,
		_limit: number | null,
		_after?: string | null,
		_blockList?: string[],
		_additionalQuery?: Record<string, unknown>[],
	): Promise<(APObject & { _id: string })[]> {
		throw notImplemented();
	}

	getStreamCount(_collectionId: string): Promise<number> {
		throw notImplemented();
	}

	getContext(_documentUrl: string): Promise<ContextRecord | undefined> {
		throw notImplemented();
	}

	getUserCount(): Promise<number> {
		throw notImplemented();
	}

	saveContext(_context: ContextRecord): Promise<void> {
		throw notImplemented();
	}

	saveActivity(_activity: APObject): Promise<SaveActivityResult> {
		throw notImplemented();
	}

	removeActivity(_activity: APObject, _actorId: string): Promise<void> {
		throw notImplemented();
	}

	updateActivity(_activity: Partial<APObject>, _fullReplace: boolean): Promise<APObject> {
		throw notImplemented();
	}

	updateActivityMeta(
		_activity: APObject,
		_key: string,
		_value: unknown,
		_remove?: boolean,
	): Promise<APObject> {
		throw notImplemented();
	}

	generateId(): string {
		throw notImplemented();
	}

	updateObject(_obj: APObject, _actorId: string | null, _fullReplace: boolean): Promise<APObject> {
		throw notImplemented();
	}

	deliveryDequeue(): Promise<DeliveryQueueRecord | { waitUntil: Date } | null> {
		throw notImplemented();
	}

	deliveryEnqueue(
		_actorId: string,
		_body: string,
		_addresses: string | string[],
		_signingKey: string | undefined,
	): Promise<boolean> {
		throw notImplemented();
	}

	deliveryRequeue(_delivery: DeliveryQueueRecord): Promise<boolean> {
		throw notImplemented();
	}
}
