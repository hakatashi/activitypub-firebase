import type { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import onFinished from 'on-finished';
import { getLocals } from './net/locals.js';
import net from './net/index.js';
import * as pub from './pub/index.js';
import type { ApexStore } from './store/interface.js';
import type { Apex, ApexEvents, ApexSettings, JsonLdContext, PubMethods } from './types.js';
import { errorMessage } from './values.js';

export type * from './types.js';
export type { ApexLocals, PostWorkTask } from './net/locals.js';
export type { CollectionInfo } from './pub/utils.js';
export type { DeliverResult } from './pub/federation.js';
export type { RemoteFetchPolicy } from './pub/ssrf.js';
export type {
	ApexStore,
	ContextRecord,
	DeliveryQueueRecord,
	SaveActivityResult,
	SaveActivityStatus,
} from './store/interface.js';

// bind pub methods at top level so their 'this' is apex instance.
// Object.fromEntries はキーごとの型を失うため、ここでだけ型アサーションを許す (→ ADR-0051)。
const bindPub = (self: object): PubMethods =>
	Object.fromEntries(
		Object.entries(pub).map(([key, value]) => [
			key,
			typeof value === 'function' ? value.bind(self) : value,
		]),
	) as PubMethods;

const buildUtils = (
	apex: PubMethods,
	settings: ApexSettings,
	baseUrl: string,
	params: {
		actorParam: string;
		objectParam: string;
		activityParam: string;
		collectionParam: string;
	},
) => {
	const { routes } = settings;
	const { actorParam, objectParam, activityParam, collectionParam } = params;
	return {
		usernameToIRI: apex.idToIRIFactory(baseUrl, routes.actor, actorParam),
		objectIdToIRI: apex.idToIRIFactory(baseUrl, routes.object, objectParam),
		activityIdToIRI: apex.idToIRIFactory(baseUrl, routes.activity, activityParam),
		userCollectionIdToIRI: apex.userAndIdToIRIFactory(
			baseUrl,
			routes.collections,
			actorParam,
			collectionParam,
		),
		nameToActorStreams: apex.nameToActorStreamsFactory(baseUrl, routes, actorParam),
		nameToBlockedIRI: apex.idToIRIFactory(baseUrl, routes.blocked, actorParam),
		nameToRejectedIRI: apex.idToIRIFactory(baseUrl, routes.rejected, actorParam),
		nameToRejectionsIRI: apex.idToIRIFactory(baseUrl, routes.rejections, actorParam),
		idToActivityCollections: apex.idToActivityCollectionsFactory(baseUrl, routes, activityParam),
		iriToCollectionInfo: apex.iriToCollectionInfoFactory(
			baseUrl,
			routes,
			actorParam,
			activityParam,
			collectionParam,
		),
	};
};

export type ApexUtils = ReturnType<typeof buildUtils>;

// apex-inbox / apex-outbox の購読。Express の Application は EventEmitter だが、
// 型定義の on() は 'mount' イベントに特化しているため EventEmitter として受け取る。
export const onApexEvent = <K extends keyof ApexEvents>(
	emitter: EventEmitter,
	eventName: K,
	listener: (message: ApexEvents[K]) => unknown,
): void => {
	emitter.on(eventName, listener);
};

const ActivitypubExpress = <S extends ApexStore>(settings: ApexSettings<S>): Apex<S> => {
	if (!settings.store) {
		throw new Error('Store is required');
	}
	const logger = settings.logger ?? console;

	const onFinishedHandler = (err: Error | null, res: Response) => {
		if (err) {
			return;
		}
		const apexLocal = getLocals(res);
		// execute postWork tasks in sequence (not parallel)
		apexLocal.postWork
			.reduce<Promise<unknown>>((acc, task) => acc.then(() => task(res)), Promise.resolve())
			.then(() => {
				if (apexLocal.eventName) {
					res.app.emit(apexLocal.eventName, apexLocal.eventMessage);
				}
			})
			.catch((postWorkErr: unknown) => {
				logger.error('post-response error:', errorMessage(postWorkErr));
			});
	};

	const middleware = (req: Request, res: Response, next: NextFunction): void => {
		// apex api object
		req.app.locals.apex = middleware;
		res.locals.apex = {
			eventName: null,
			eventMessage: {},
			postWork: [],
		};
		onFinished(res, onFinishedHandler);
		next();
	};

	let baseUrl;
	let domain;
	if (settings.baseUrl === undefined) {
		// Assumes settings.domain is set (backward-compatible)
		baseUrl = `https://${settings.domain}`;
		({ domain } = settings);
	} else {
		baseUrl = settings.baseUrl;
		domain = new URL(baseUrl).host;
	}
	const asContext: JsonLdContext[] = pub.consts.ASContext;
	const params = {
		actorParam: settings.actorParam,
		objectParam: settings.objectParam,
		activityParam: settings.activityParam || settings.objectParam,
		collectionParam: settings.collectionParam || settings.objectParam,
	};
	const core = {
		settings,
		baseUrl,
		domain,
		context: settings.context ? asContext.concat(settings.context) : asContext,
		net,
		store: settings.store,
		...params,
		pageParam: settings.pageParam || 'page',
		itemsPerPage: settings.itemsPerPage || 20,
		threadDepth: settings.threadDepth || 10,
		systemUser: settings.systemUser,
		logger,
		offlineMode: settings.offlineMode,
		requestTimeout: settings.requestTimeout ?? 5000,
	};
	// pub の関数は呼び出し時に this (= apex) のプロパティを読むので、束縛の時点では
	// 組み立て途中のオブジェクトを渡してよい
	const withCore = Object.assign(middleware, core);
	const methods = bindPub(withCore);
	const utils = buildUtils(methods, settings, baseUrl, params);
	const apex: Apex<S> = Object.assign(withCore, methods, { utils });
	return apex;
};

export default ActivitypubExpress;
