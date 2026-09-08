import type { APObject, DeliveryQueueRecord } from '../index.js';

declare namespace IApexStore {
	export interface SaveActivityResult {
		isNew: true | 'new collection' | false;
		activity?: APObject;
	}
}

declare class IApexStore {
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
	getStream(
		collectionId: string,
		limit: number | null,
		after?: string | null,
		blockList?: string[],
		additionalQuery?: Record<string, unknown>[],
	): Promise<(APObject & { _id: string })[]>;
	getStreamCount(collectionId: string): Promise<number>;
	getContext(documentUrl: string): Promise<
		| {
				contextUrl: string | null;
				documentUrl: string;
				document: unknown;
		  }
		| undefined
	>;
	getUserCount(): Promise<number>;
	saveContext(context: {
		contextUrl: string | null;
		documentUrl: string;
		document: unknown;
	}): Promise<void>;
	saveActivity(activity: APObject): Promise<IApexStore.SaveActivityResult>;
	removeActivity(activity: APObject, actorId: string): Promise<void>;
	updateActivity(activity: APObject, fullReplace: boolean): Promise<APObject>;
	updateActivityMeta(
		activity: APObject,
		key: string,
		value: unknown,
		remove: boolean,
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

export = IApexStore;
