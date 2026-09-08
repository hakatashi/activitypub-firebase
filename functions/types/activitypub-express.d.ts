// activitypub-express (v4.4.1, ADR-0010 で固定) は型定義を同梱せず、DefinitelyTyped にも
// 存在しない。ここでは functions/src が実際に使っている API のみを、
// node_modules/activitypub-express の実装を読んで型付けする (→ ADR-0022)。
// ランタイム検証は行わない。実装とずれた場合は静かに誤った型が伝播する。
//
// 未定義のメンバーを呼べばコンパイルエラーになるが、それは必要になった時点で追記する。

declare module 'activitypub-express' {
	import type { NextFunction, Request, RequestHandler, Response } from 'express';
	import type IApexStore from 'activitypub-express/store/interface.js';
	import type { APObject as OriginalAPObject, APActor, APActivity } from 'activitypub-types';

	// apex は jsonld.compact(compactArrays: false) を通した「部分展開」形式でオブジェクトを
	// 扱うため、ほとんどのプロパティは単一要素配列に boxing される
	// (例: actor.inbox[0], activity.actor[0] → node_modules/activitypub-express/pub/collection.js:83)。
	// 一方 `id` と `type` は素の文字列のまま扱われる
	// (net/activity.js:93 `activity.type.toLowerCase()`)。
	// プロパティごとに boxing の有無が異なり静的に表現しきれないため、
	// `id` / `type` 以外は index signature で受ける。
	//
	// `_meta` が持つ既知のキーの集合は functions/src/meta.ts の ObjectMeta に集約する
	// (二重定義による乖離を避けるため)。アンビエントモジュール宣言の内側では相対パスの
	// `import` 宣言が使えない (TS2439) ため、インライン `import()` 型で参照する。
	// `skipLibCheck: true` はこのファイルの意味検査自体をスキップするため、
	// 通常の `import` で書くと型解決の失敗が黙って `any` にフォールバックし、
	// ADR-0026 の any 禁止が骨抜きになる。
	export interface APObject extends OriginalAPObject {
		id: string;
		type: string;
		_meta?: import('../src/meta.js').ObjectMeta;
	}

	// toJSONLD が返す jsonld.compact 後の actor 形状(mastodon/api.ts の actorObjectToAccount
	// が使う最小限のプロパティのみ)。activitypub-types の APActor は icon/image を
	// IconField|ImageField の union として定義するなど、jsonld.compact 後の緩いプロパティ
	// アクセスと厳密には一致しないため、この専用の型を toJSONLD の呼び出し元と共有する。
	export interface JsonLdActor {
		id: string;
		preferredUsername?: string;
		name?: string;
		summary?: string;
		discoverable?: boolean;
		icon?: { url?: string };
		image?: { url?: string };
	}

	// store/index.js (参考実装) の deliveryQueue ドキュメント形状。
	// このプロジェクトでは配送を Cloud Tasks 経由で行っており (ADR-0003)、
	// apex.offlineMode = true により deliveryDequeue/deliveryRequeue は実際には呼ばれない。
	export interface DeliveryQueueRecord {
		address: string;
		actorId: string;
		signingKey: string;
		body: string;
		attempt: number;
		after: Date;
	}

	// store/interface.js が定義する契約(20メソッド、IApexStore として別途宣言)に、
	// このプロジェクトの Store (functions/src/store.ts) が独自に拡張しているメソッドを加えたもの。
	// `deliveries` コレクションのドキュメント形状は Firestore スキーマの一部であり、
	// functions/src/schema.ts に集約する (→ ADR-0023)。上記 `_meta` と同様の理由で
	// インライン `import()` 型で参照する。
	type DeliveryRecord = import('../src/schema.js').DeliveryRecord;

	export interface ApexStore extends IApexStore {
		// 以下、Store 独自の拡張 (functions/src/store.ts のコメント参照)
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

	// net/index.js のルートグループのうち、functions/src が参照しているもののみ
	export interface ApexNet {
		inbox: { get: RequestHandler[]; post: RequestHandler[] };
		// inbox.post 配列内の要素を参照で特定するために必要(→ ADR-0030)。
		activity: { save: RequestHandler };
		// 同上、同一オリジン検証の挿入位置を特定するために必要(→ ADR-0031)。
		// activityObject は ADR-0038 で inboxActivity との分割点を特定するために必要。
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

	// pub/utils.js の idToIRIFactory が返す関数のうち、実際に使っているもののみ
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

	// index.js が受け取る settings のうち、functions/src/apex.ts が渡しているもののみ
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

	// index.js が返す apex インスタンス。Express ミドルウェアとして呼び出し可能かつ、
	// pub/*.js の各関数が 'this' 経由でトップレベルに生やされている (index.js:19-25)。
	export interface Apex {
		(req: Request, res: Response, next: NextFunction): void;
		net: ApexNet;
		store: ApexStore;
		utils: ApexUtils;
		consts: ApexConsts;
		systemUser?: APObject;
		requestTimeout: number;
		offlineMode?: boolean;

		// pub/actor.js
		createActor(
			username: string,
			displayName: string,
			summary: string,
			icon: string | undefined,
			type?: string,
		): Promise<APObject & APActor>;
		// pub/activity.js
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
		// pub/object.js。includeMeta=true 固定、refresh/localOnly は未使用のため省略 (→ ADR-0038)。
		resolveObject(id: string, includeMeta?: boolean): Promise<APObject>;
		// pub/activity.js。needsResolveActivity (Accept/Add/Announce/Like/Reject/Remove) が使う。
		// テストで「streams に無く、HTTP 再取得でも activity として検証できない」状態
		// (validateActivity が false になる Note などが対象の場合)を再現するためにモックする
		// (→ ADR-0038)。
		resolveActivity(id: string, includeMeta?: boolean): Promise<APObject | undefined>;
		// pub/utils.js の validateActivity。id/type に加えて actor 配列が空でないことを要求する。
		validateActivity(object: unknown): boolean;
		// pub/utils.js
		// mastodon/api.ts など、apex 内部の APObject 表現を持たない値(activitypub-types の
		// APActor 等)からも呼ばれるため、引数は index signature を要求しない `object` で受ける。
		toJSONLD<T = Record<string, unknown>>(obj: object): Promise<T>;
		// resolveObject/resolveUnknown が渡す JSON-LD 展開前の生オブジェクトを正規化する
		// (functions/src/security/safeRequestObject.ts が requestObject の差し替え後に呼ぶ)。
		fromJSONLD(obj: unknown): Promise<APObject>;
		// pub/federation.js
		deliver(
			actorId: string,
			activity: string,
			address: string,
			signingKey: string,
		): Promise<DeliverResult | null>;
		makeUserAgentString(): string;
		// resolveObject/resolveUnknown/resolveReferences が内部で呼ぶ未知 IRI の fetch。
		// apex.ts で SSRF セーフな自前実装に差し替える (→ ADR-0032)。安全でない URL や
		// 取得失敗時は例外を投げる(呼び出し元の Promise.allSettled が個別に無視する)。
		requestObject(id: string): Promise<APObject>;
	}

	function ActivitypubExpress(settings: ApexSettings): Apex;
	export default ActivitypubExpress;
}

// store/interface.js: 全メソッドが `throw new Error('Not implemented')` するだけの基底クラス。
// functions/src/store.ts の Store はこれを継承し、必要なメソッドだけを override する。
// override しないメソッド(deliveryDequeue/deliveryRequeue)はこの基底クラスの実装がそのまま
// 使われ、呼び出されると例外を投げる (→ ADR-0003, Issue #84)。
declare module 'activitypub-express/store/interface.js' {
	import type { APObject, DeliveryQueueRecord } from 'activitypub-express';

	export default class IApexStore {
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
		// oxlint-disable-next-line max-params
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
		// interface.js 自体は `getUsercount` という誤字だが、実際に呼ばれるのは
		// pub/nodeinfo.js:13 の `getUserCount` なのでそちらを正とする。
		getUserCount(): Promise<number>;
		saveContext(context: {
			contextUrl: string | null;
			documentUrl: string;
			document: unknown;
		}): Promise<void>;
		saveActivity(activity: APObject): Promise<true | undefined>;
		removeActivity(activity: APObject, actorId: string): Promise<void>;
		updateActivity(activity: APObject, fullReplace: boolean): Promise<APObject>;
		// oxlint-disable-next-line max-params
		updateActivityMeta(
			activity: APObject,
			key: string,
			value: unknown,
			remove: boolean,
		): Promise<APObject>;
		updateObject(obj: APObject, actorId: string | null, fullReplace: boolean): Promise<APObject>;
		deliveryDequeue(): Promise<DeliveryQueueRecord | { waitUntil: Date } | null>;
		// oxlint-disable-next-line max-params
		deliveryEnqueue(
			actorId: string,
			body: string,
			addresses: string | string[],
			signingKey: string | undefined,
		): Promise<boolean>;
		deliveryRequeue(delivery: DeliveryQueueRecord): Promise<boolean>;
	}
}
