import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { APObject as OriginalAPObject, APActor, APActivity } from 'activitypub-types';
import type IApexStore from './store/interface.js';

declare function ActivitypubExpress(settings: ActivitypubExpress.ApexSettings): ActivitypubExpress.Apex;

declare namespace ActivitypubExpress {
	export interface ObjectMeta {
		collection?: string[];
		privateKey?: string;
		isPublic?: boolean;
		[key: string]: unknown;
	}

	export interface APObject extends OriginalAPObject {
		id: string;
		type: string;
		_meta?: ObjectMeta;
		[key: string]: unknown;
	}

	export interface JsonLdActor {
		id: string;
		preferredUsername?: string;
		name?: string;
		summary?: string;
		discoverable?: boolean;
		icon?: { url?: string };
		image?: { url?: string };
	}

	export interface DeliveryQueueRecord {
		address: string;
		actorId: string;
		signingKey: string;
		body: string;
		attempt: number;
		after: Date;
	}

	export interface DeliveryRecord {
		activityId: string;
		actorId: string;
		inbox: string;
		body: string;
		attempts: number;
		status: 'permanent_failure' | 'retrying' | 'success';
		statusCode: number | null;
		error: string | null;
		updatedAt: unknown;
	}

	export interface ApexStore extends IApexStore {
		getObjects(ids: string[], includeMeta?: boolean): Promise<APObject[]>;
		getObjectsByFieldValue(
			field: string,
			value: unknown,
			includeMeta?: boolean,
		): Promise<APObject[]>;
		getObjectsCount(field: string, value: unknown): Promise<number>;
		recordDeliveryResult(result: {
			activityId: string;
			actorId: string;
			address: string;
			body: string;
			attempts: number;
			status: 'permanent_failure' | 'retrying' | 'success';
			statusCode?: number;
			error?: string;
		}): Promise<void>;
		getFailedDeliveries(): Promise<DeliveryRecord[]>;
		getDelivery(activityId: string, address: string): Promise<DeliveryRecord | undefined>;
		markActivityPublic(activity: APObject): Promise<void>;
	}

	export interface ApexNet {
		inbox: { get: RequestHandler[]; post: RequestHandler[] };
		activity: { save: RequestHandler };
		validators: { inboxActivity: RequestHandler; activityObject: RequestHandler };
		outbox: { get: RequestHandler[]; post: RequestHandler[] };
		actor: { get: RequestHandler[] };
		followers: { get: RequestHandler[] };
		following: { get: RequestHandler[] };
		liked: { get: RequestHandler[] };
		object: { get: RequestHandler[] };
		activityStream: { get: RequestHandler[] };
		shares: { get: RequestHandler[] };
		likes: { get: RequestHandler[] };
		webfinger: { get: RequestHandler[] };
		nodeInfoLocation: { get: RequestHandler[] };
		nodeInfo: { get: RequestHandler[] };
		proxy: { post: RequestHandler[] };
	}

	export interface ApexUtils {
		objectIdToIRI(id?: string): string;
	}

	export interface ApexConsts {
		jsonldTypes: string[];
	}

	export interface DeliverResult {
		statusCode: number;
		[key: string]: unknown;
	}

	export interface ApexSettings {
		name: string;
		version: string;
		domain: string;
		actorParam: string;
		objectParam: string;
		activityParam: string;
		logger: Pick<Console, 'error' | 'info' | 'warn'>;
		routes: Record<string, string>;
		store: ApexStore;
		offlineMode?: boolean;
		endpoints?: {
			proxyUrl: string;
		};
		nodeInfoMetadata?: {
			nodeName: string;
			name: string;
		};
	}

	export interface Apex {
		(req: Request, res: Response, next: NextFunction): void;
		net: ApexNet;
		store: ApexStore;
		utils: ApexUtils;
		consts: ApexConsts;
		systemUser?: APObject;
		requestTimeout: number;
		offlineMode?: boolean;

		createActor(
			username: string,
			displayName: string,
			summary: string,
			icon: string | undefined,
			type?: string,
		): Promise<APObject & APActor>;
		buildActivity(
			type: string,
			actorId: string,
			to: string | string[],
			etc?: Record<string, unknown>,
		): Promise<APObject & APActivity>;
		addToOutbox(actor: APObject, activity: APObject): Promise<unknown>;
		acceptFollow(
			actor: APObject,
			targetActivity: APObject,
		): Promise<{ postTask: () => Promise<unknown>; updated: unknown }>;
		publishUpdate(actor: APObject, object: APObject, cc?: string): Promise<unknown>;
		resolveObject(id: string, includeMeta?: boolean): Promise<APObject>;
		resolveActivity(id: string, includeMeta?: boolean): Promise<APObject | undefined>;
		validateActivity(object: unknown): boolean;
		toJSONLD<T = Record<string, unknown>>(obj: object): Promise<T>;
		fromJSONLD(obj: unknown): Promise<APObject>;
		deliver(
			actorId: string,
			activity: string,
			address: string,
			signingKey: string,
		): Promise<DeliverResult | null>;
		makeUserAgentString(): string;
		requestObject(id: string): Promise<APObject>;
	}
}

export = ActivitypubExpress;
