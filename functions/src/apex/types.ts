import type { NextFunction, Request, Response } from 'express';
import type { ApexUtils } from './index.js';
import type net from './net/index.js';
import type * as pub from './pub/index.js';
import type { RemoteFetchPolicy } from './pub/ssrf.js';
import type { ApexStore } from './store/interface.js';

// `_meta` は Store 実装やアプリケーションが自由にキーを足す。apex 自身が読み書きするキーだけ型を与え、
// アプリケーション固有のキーは module augmentation で足す (→ ADR-0051)。
export interface ObjectMeta {
	collection?: string[];
	privateKey?: string;
	isPublic?: boolean;
	[key: string]: unknown;
}

// リクエスト処理中だけ actor に載せる一時データ (永続化されない)
export interface LocalState {
	blockList: string[];
}

// fromJSONLD で正規化した後の AP オブジェクト。プロパティは (id / type を除いて) 配列に展開されている
// (compactArrays: false) ため、単数/配列の union で書かれた activitypub-types の型とは形が合わない。
// id / type 以外は unknown として読み、values.ts のヘルパーで絞る。
export interface APObject {
	id: string;
	type: string;
	_meta?: ObjectMeta;
	_local?: LocalState;
	[key: string]: unknown;
}

// toJSONLD (compactArrays: true) で外部送出用に戻した actor の形
export interface JsonLdActor {
	id: string;
	preferredUsername?: string;
	name?: string;
	summary?: string;
	discoverable?: boolean;
	icon?: { url?: string };
	image?: { url?: string };
}

export interface ApexLogger {
	error(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
}

export interface ApexRoutes {
	actor: string;
	object: string;
	activity: string;
	inbox: string;
	outbox: string;
	followers: string;
	following: string;
	liked: string;
	collections: string;
	blocked: string;
	rejections: string;
	rejected: string;
	shares: string;
	likes: string;
}

export type JsonLdContext = string | Record<string, unknown>;

export interface ApexSettings<S extends ApexStore = ApexStore> {
	name: string;
	version: string;
	domain: string;
	baseUrl?: string;
	context?: JsonLdContext | JsonLdContext[];
	actorParam: string;
	objectParam: string;
	activityParam?: string;
	collectionParam?: string;
	pageParam?: string;
	itemsPerPage?: number;
	threadDepth?: number;
	systemUser?: APObject;
	logger?: ApexLogger;
	routes: ApexRoutes;
	store: S;
	offlineMode?: boolean;
	requestTimeout?: number;
	openRegistrations?: boolean;
	remoteFetchPolicy?: RemoteFetchPolicy | (() => RemoteFetchPolicy);
	endpoints?: Record<string, string>;
	nodeInfoMetadata?: Record<string, unknown>;
}

// index.ts が設定から組み立てるプロパティ
export interface ApexCore<S extends ApexStore = ApexStore> {
	(req: Request, res: Response, next: NextFunction): void;
	settings: ApexSettings<S>;
	baseUrl: string;
	domain: string;
	context: JsonLdContext[];
	net: typeof net;
	store: S;
	actorParam: string;
	objectParam: string;
	activityParam: string;
	collectionParam: string;
	pageParam: string;
	itemsPerPage: number;
	threadDepth: number;
	systemUser: APObject | undefined;
	logger: ApexLogger;
	offlineMode: boolean | undefined;
	requestTimeout: number;
	utils: ApexUtils;
}

type Pub = typeof pub;

// pub/* の各関数は `this: Apex` を取る。インスタンス上では this を束縛済みの形で公開される。
// OmitThisParameter は型引数を落とすため、総称関数の toJSONLD だけは束縛後の形を書き下す。
export type PubMethods = {
	[K in Exclude<keyof Pub, 'toJSONLD'>]: OmitThisParameter<Pub[K]>;
} & {
	toJSONLD: <T = Record<string, unknown>>(
		...args: Parameters<OmitThisParameter<Pub['toJSONLD']>>
	) => Promise<T>;
};

export interface Apex<S extends ApexStore = ApexStore> extends ApexCore<S>, PubMethods {}

// net/activity.ts の inboxSideEffects / outboxSideEffects が発火させるイベントのペイロード。
// outbox 側には recipient が存在しない (受信者ではなく送信者の actor だけが分かる)。
export interface ApexInboxMessage {
	actor: APObject;
	activity: APObject;
	recipient: APObject;
	object: APObject | undefined;
}

export interface ApexOutboxMessage {
	actor: APObject;
	activity: APObject;
	// Block は解決できなかった相手も IRI のまま対象にする
	object: APObject | string | undefined;
}

export interface ApexEvents {
	'apex-inbox': ApexInboxMessage;
	'apex-outbox': ApexOutboxMessage;
}
