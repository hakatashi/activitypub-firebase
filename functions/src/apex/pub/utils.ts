import merge from 'deepmerge';
import jsonld from 'jsonld';
import type { ContextDefinition, JsonLdDocument, Options } from 'jsonld';
import type { Apex, APObject, ApexRoutes } from '../types.js';
import asVocab from '../vocab/as.json' with { type: 'json' };
import securityVocab from '../vocab/security.json' with { type: 'json' };
import {
	errorMessage,
	first,
	firstId,
	isAPObject,
	isRecord,
	isString,
	toArray,
} from '../values.js';

type DocumentLoader = NonNullable<Options.Compact['documentLoader']>;
type RemoteDocument = Awaited<ReturnType<DocumentLoader>>;

// @types/jsonld には documentLoaders が定義されていない
declare module 'jsonld' {
	export const documentLoaders: {
		node: () => (url: string) => Promise<RemoteDocument>;
	};
}

const actorStreamNames = [
	'inbox',
	'outbox',
	'following',
	'followers',
	'liked',
	'blocked',
	'rejected',
	'rejections',
] as const;
const activityStreamNames = ['shares', 'likes'] as const;
const audienceFields = ['to', 'bto', 'cc', 'bcc', 'audience'] as const;

export type ActorStreamName = (typeof actorStreamNames)[number];
export type ActivityStreamName = (typeof activityStreamNames)[number];

export interface CollectionInfo {
	name: 'collections' | ActorStreamName | ActivityStreamName;
	actor?: string;
	id?: string;
	activity?: string;
}

export const addPageToIRI = function (
	this: Apex,
	id: string,
	pageId: string | number | boolean,
): string {
	const url = new URL(id);
	const query = new URLSearchParams(url.search);
	query.set(this.pageParam, String(pageId));
	url.search = query.toString();
	return url.toString();
};

export const addMeta = (obj: APObject, key: string, value: unknown): void => {
	obj._meta ??= {};
	const current = obj._meta[key];
	if (Array.isArray(current)) {
		current.push(value);
	} else {
		obj._meta[key] = [value];
	}
};

export const audienceFromActivity = (activity: Record<string, unknown>): unknown[] =>
	audienceFields.reduce<unknown[]>(
		(acc, field) => (activity[field] ? acc.concat(activity[field]) : acc),
		[],
	);

export const hasMeta = (obj: APObject, key: string, value: unknown): boolean => {
	const current = obj._meta?.[key];
	if (!Array.isArray(current)) {
		return false;
	}
	return current.includes(value);
};

export const removeMeta = (obj: APObject, key: string, value: unknown): void => {
	const current = obj._meta?.[key];
	if (!Array.isArray(current)) {
		return;
	}
	const i = current.indexOf(value);
	if (i !== -1) {
		current.splice(i, 1);
	}
};

// Link の場合はリンク先を返す
const idOfReference = (reference: unknown): string | undefined => {
	if (isString(reference)) {
		return reference;
	}
	if (!isRecord(reference)) {
		return undefined;
	}
	if (reference.type === 'Link') {
		const href = first(reference.href);
		return isString(href) ? href : undefined;
	}
	return typeof reference.id === 'string' ? reference.id : undefined;
};

export const actorIdFromActivity = (activity: Record<string, unknown>): string | undefined =>
	idOfReference(first(activity.actor));

export const objectIdFromActivity = (activity: Record<string, unknown>): string | null => {
	const object = Array.isArray(activity.object) ? first(activity.object) : undefined;
	if (!object) {
		return null;
	}
	return idOfReference(object) ?? null;
};

export const objectIdFromValue = (object: unknown): string | undefined => firstId(object);

export const iriToCollectionInfoFactory = function (
	this: Apex,
	baseUrl: string,
	_routes: ApexRoutes,
	actorParam: string,
	activityParam: string,
	collectionParam: string,
): (iri: string) => CollectionInfo | undefined {
	const pActor = `:${actorParam}`;
	const pActivity = `:${activityParam}`;
	const pCollection = `:${collectionParam}`;
	const tests: ((iri: string) => CollectionInfo | undefined)[] = [];
	// custom actor collections
	const collectionsPattern = this.settings.routes.collections;
	const isActorFirst = collectionsPattern.indexOf(pActor) < collectionsPattern.indexOf(pCollection);
	const collectionsRe = new RegExp(
		`^${baseUrl}${collectionsPattern.replace(pActor, '([^/]+)').replace(pCollection, '([^/]+)')}$`,
	);
	tests.push((iri) => {
		const match = collectionsRe.exec(iri);
		if (!match) {
			return undefined;
		}
		const [actor, id] = isActorFirst ? [match[1], match[2]] : [match[2], match[1]];
		return {
			name: 'collections',
			...(actor === undefined ? {} : { actor }),
			...(id === undefined ? {} : { id }),
		};
	});
	// standard actor streams
	for (const name of actorStreamNames) {
		const re = new RegExp(`^${baseUrl}${this.settings.routes[name].replace(pActor, '([^/]+)')}$`);
		tests.push((iri) => {
			const actor = re.exec(iri)?.[1];
			return actor ? { name, actor } : undefined;
		});
	}
	// activity object streams
	for (const name of activityStreamNames) {
		const re = new RegExp(
			`^${baseUrl}${this.settings.routes[name].replace(pActivity, '([^/]+)')}$`,
		);
		tests.push((iri) => {
			const activity = re.exec(iri)?.[1];
			return activity ? { name, activity } : undefined;
		});
	}
	return (iri) => {
		for (const test of tests) {
			const result = test(iri);
			if (result) {
				return result;
			}
		}
		return undefined;
	};
};

// compact leaves bare 'Public' untouched, so normalize it to 'as:Public'
const normalizePublicAddressValue = (val: unknown) => (val === 'Public' ? 'as:Public' : val);

export const normalizePublicAddresses = (target: unknown): unknown => {
	if (!target || typeof target !== 'object') {
		return target;
	}
	if (Array.isArray(target)) {
		for (const item of target) {
			normalizePublicAddresses(item);
		}
		return target;
	}
	if (!isRecord(target)) {
		return target;
	}
	for (const key of audienceFields) {
		const value = target[key];
		if (Array.isArray(value)) {
			target[key] = value.map(normalizePublicAddressValue);
		} else if (typeof value === 'string') {
			target[key] = normalizePublicAddressValue(value);
		}
	}
	for (const value of Object.values(target)) {
		if (typeof value === 'object' && value !== null) {
			normalizePublicAddresses(value);
		}
	}
	return target;
};

// JSON-LD ライブラリの入出力の型はコンテキストが決めるため、型では表せない。
// ここが apex で型アサーションを許す境界 (→ ADR-0051)。
const asJsonLdDocument = (obj: unknown) => obj as JsonLdDocument;
const asContextDefinition = (context: Apex['context']) => context as unknown as ContextDefinition;
const asRemoteDocument = (record: { documentUrl: string; document: unknown }) =>
	record as RemoteDocument;

// convert incoming json-ld to local context and
// partially expanded format for consistent property access
export const fromJSONLD = async function (this: Apex, obj: unknown): Promise<APObject | undefined> {
	const opts: Options.Compact = {
		// don't unbox arrays so that object structure will be predictable
		compactArrays: false,
		documentLoader: this.jsonldContextLoader,
	};
	const context = isRecord(obj) ? obj['@context'] : undefined;
	if (typeof obj === 'object' && obj !== null && !('@context' in obj)) {
		// if context is missing, try filling in ours
		opts.expandContext = asContextDefinition(this.context);
	} else if (Array.isArray(context)) {
		/*
			default language tags alter the structure of the processed
			jsonld, replacing some strings (preferredUsername) with
			objects and renaming some keys (summary->summaryMap),
			so just strip them for now so we can be compatible with
			pleroma
		*/
		for (const ctx of context) {
			if (isRecord(ctx) && ctx['@language']) {
				ctx['@language'] = null;
			}
		}
	} else if (isRecord(context) && context['@language']) {
		context['@language'] = null;
	}
	const compact = await jsonld.compact(
		asJsonLdDocument(obj),
		asContextDefinition(this.context),
		opts,
	);
	// strip context and graph wrapper for easier access
	const graph = compact['@graph'];
	if (!Array.isArray(graph)) {
		throw new TypeError('JSON-LD compaction did not produce a graph');
	}
	const result: unknown = graph[0];
	if (result) {
		normalizePublicAddresses(result);
	}
	return result as APObject | undefined;
};

// convert working objects to json-ld for transport
export const toJSONLD = async function <T = Record<string, unknown>>(
	this: Apex,
	obj: object,
): Promise<T> {
	const compacted = await jsonld.compact(asJsonLdDocument(obj), asContextDefinition(this.context), {
		// must supply initial context because it was stripped for easy handling
		expandContext: asContextDefinition(this.context),
		// unbox arrays on federated objects, in case other apps aren't using real json-ld
		compactArrays: true,
		documentLoader: this.jsonldContextLoader,
	});
	return compacted as T;
};

// non-exported utils
// strip any _meta or private properties to keep jsonld valid and not leak private keys
const privateActivityProps = new Set(['bto', 'bcc']);
const skipPrivate = (key: string, value: unknown) => {
	if (key.startsWith('_') || privateActivityProps.has(key)) {
		return undefined;
	}
	return value;
};

export const stringifyPublicJSONLD = (obj: unknown): string => JSON.stringify(obj, skipPrivate);

export const idToIRIFactory = function (
	this: Apex,
	baseUrl: string,
	route: string,
	param: string,
): (id?: string) => string {
	const colonParam = `:${param}`;
	return (id) =>
		`${baseUrl}${route.replace(colonParam, id || this.store.generateId())}`.toLowerCase();
};

export const userAndIdToIRIFactory = function (
	this: Apex,
	baseUrl: string,
	route: string,
	userParam: string,
	param: string,
): (user: string, id?: string) => string {
	const colonParam = `:${param}`;
	const colonUserParam = `:${userParam}`;
	return (user, id) =>
		`${baseUrl}${route.replace(colonParam, id || this.store.generateId()).replace(colonUserParam, user)}`.toLowerCase();
};

export const isLocalIRI = function (this: Apex, id: unknown): boolean {
	return typeof id === 'string' && id.startsWith(this.baseUrl);
};

export const isLocalCollection = function (this: Apex, object: unknown): boolean {
	if (!isRecord(object)) {
		return false;
	}
	const isCollection = object.type === 'Collection' || object.type === 'OrderedCollection';
	return isCollection && this.isLocalIRI(object.id);
};

export const isPublic = function (this: Apex, object: APObject): boolean {
	return (
		Boolean(object._meta?.isPublic) ||
		this.audienceFromActivity(object).includes(this.consts.publicAddress)
	);
};

export const originOf = (id: unknown): string | undefined => {
	if (typeof id !== 'string') {
		return undefined;
	}
	try {
		return new URL(id).origin;
	} catch {
		return undefined;
	}
};

export const isSameOrigin = (id1: unknown, id2: unknown): boolean => {
	const origin1 = originOf(id1);
	const origin2 = originOf(id2);
	return origin1 !== undefined && origin1 === origin2;
};

/* just checking a subset of cases becuase others (like no protocol)
 * would error anyway during request and we don't have to bog down
 * federation with additional regex or url parsing
 */
const localhosts = [
	'http://localhost',
	'https://localhost',
	'http://127.0.0.1',
	'https://127.0.0.1',
];

export const isLocalhostIRI = (id: string): boolean => localhosts.some((lh) => id.startsWith(lh));

export const isProductionEnv = (): boolean => process.env.NODE_ENV === 'production';

const overwriteArrays: merge.Options = {
	arrayMerge: (_destinationArray, sourceArray) => sourceArray,
};

export const mergeJSONLD = <T>(target: Partial<T>, source: Partial<T>): T =>
	merge<T>(target, source, overwriteArrays);

export const nameToActorStreamsFactory = (
	baseUrl: string,
	routes: ApexRoutes,
	actorParam: string,
): ((name: string) => Record<ActorStreamName, string>) => {
	const colonParam = `:${actorParam}`;
	return (name) => {
		const stream = (s: ActorStreamName) => `${baseUrl}${routes[s]}`.replace(colonParam, name);
		return {
			inbox: stream('inbox'),
			outbox: stream('outbox'),
			following: stream('following'),
			followers: stream('followers'),
			liked: stream('liked'),
			blocked: stream('blocked'),
			rejected: stream('rejected'),
			rejections: stream('rejections'),
		};
	};
};

export const idToActivityCollectionsFactory = (
	baseUrl: string,
	routes: ApexRoutes,
	activityParam: string,
): ((id: string) => Record<ActivityStreamName, string>) => {
	const colonParam = `:${activityParam}`;
	return (id) => ({
		shares: `${baseUrl}${routes.shares}`.replace(colonParam, id).toLowerCase(),
		likes: `${baseUrl}${routes.likes}`.replace(colonParam, id).toLowerCase(),
	});
};

export const validateObject = (object: unknown): boolean => isAPObject(first(object));

export const validateActivity = (object: unknown): boolean => {
	const activity = first(object);
	return isAPObject(activity) && Array.isArray(activity.actor) && activity.actor.length > 0;
};

export const validateOwner = (objectOrArray: unknown, actorOrArray: unknown): boolean => {
	const object = first(objectOrArray);
	const actor = first(actorOrArray);
	if (!isAPObject(object) || !isRecord(actor) || typeof actor.id !== 'string' || !actor.id) {
		return false;
	}
	if (!isSameOrigin(object.id, actor.id)) {
		return false;
	}
	if (object.id === actor.id) {
		return true;
	}
	if (Array.isArray(object.actor) && object.actor[0] === actor.id) {
		return true;
	}
	if (Array.isArray(object.attributedTo) && object.attributedTo[0] === actor.id) {
		return true;
	}
	// collections don't have owner in a property, but should be in actor object
	if (object.type === 'Collection' || object.type === 'OrderedCollection') {
		// standard collections
		if (
			actorStreamNames.some((c) => {
				const stream = actor[c];
				return Array.isArray(stream) && stream.includes(object.id);
			})
		) {
			return true;
		}
		// custom collections
		const streams = first(actor.streams);
		if (isRecord(streams) && Object.values(streams).includes(object.id)) {
			return true;
		}
	}
	return false;
};

// Can be used to check activity.target instead of activity.object by specifying prop
export const validateTarget = (
	objectOrArray: unknown,
	targetId: string,
	prop = 'object',
): boolean => {
	const object = first(objectOrArray);
	if (!isAPObject(object) || !Array.isArray(object[prop])) {
		return false;
	}
	const target: unknown = toArray(object[prop])[0];
	if (!target) {
		return false;
	}
	return target === targetId || (isRecord(target) && target.id === targetId);
};

// keep main contexts in memory for speedy access
const coreContexts: Record<string, RemoteDocument> = {
	'https://w3id.org/security/v1': asRemoteDocument({
		documentUrl: 'https://w3id.org/security/v1',
		document: securityVocab,
	}),
	'https://www.w3.org/ns/activitystreams': asRemoteDocument({
		documentUrl: 'https://www.w3.org/ns/activitystreams',
		document: asVocab,
	}),
};
// cached JSONLD contexts to reduce requests an eliminate
// failures caused when context servers are unavailable
const nodeDocumentLoader = jsonld.documentLoaders.node();

export const jsonldContextLoader = async function (
	this: Apex,
	url: string,
): Promise<RemoteDocument> {
	const core = coreContexts[url];
	if (core) {
		return core;
	}
	try {
		const cached = await this.store.getContext(url);
		if (cached) {
			return asRemoteDocument(cached);
		}
	} catch (err) {
		this.logger.error('Error checking jsonld context cache', errorMessage(err));
	}
	const context = await nodeDocumentLoader(url);
	if (context?.document) {
		try {
			// save original url in case of redirects
			context.documentUrl = url;
			await this.store.saveContext({
				contextUrl: context.contextUrl ?? null,
				documentUrl: context.documentUrl,
				document: context.document,
			});
		} catch (err) {
			this.logger.error('Error saving jsonld context cache', errorMessage(err));
		}
	}
	return context;
};
