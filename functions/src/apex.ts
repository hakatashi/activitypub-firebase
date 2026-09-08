import type { EventEmitter } from 'node:events';
import type { APObject } from './apex/index.js';
import ActivitypubExpress from './apex/index.js';
import type { Express } from 'express';
import { logger } from 'firebase-functions/v2';
import { domain } from './firebase.js';
import { safeRequestObject } from './security/safeRequestObject.js';
import Store from './store.js';

// activitypub.ts と tasks.ts の両方が apex インスタンスを必要とするため、
// import サイクルを避けてここに切り出している。
export const routes = {
	actor: '/activitypub/u/:actor',
	object: '/activitypub/o/:id',
	activity: '/activitypub/s/:id',
	inbox: '/activitypub/u/:actor/inbox',
	outbox: '/activitypub/u/:actor/outbox',
	followers: '/activitypub/u/:actor/followers',
	following: '/activitypub/u/:actor/following',
	liked: '/activitypub/u/:actor/liked',
	collections: '/activitypub/u/:actor/c/:id',
	blocked: '/activitypub/u/:actor/blocked',
	rejections: '/activitypub/u/:actor/rejections',
	rejected: '/activitypub/u/:actor/rejected',
	shares: '/activitypub/s/:id/shares',
	likes: '/activitypub/s/:id/likes',
};

export const apex = ActivitypubExpress({
	name: 'activitypub-firebase',
	version: '1.0.0',
	domain,
	actorParam: 'actor',
	objectParam: 'id',
	activityParam: 'id',
	logger,
	routes,
	store: new Store(),
	offlineMode: true,
	endpoints: {
		proxyUrl: `https://${domain}/activitypub/proxy`,
	},
	nodeInfoMetadata: {
		nodeName: '博多市',
		name: '博多市',
	},
});

// リモートの未知 IRI 取得を SSRF セーフな自前実装に差し替える。index.js が pub/* の全関数を
// `apex[prop] = pub[prop].bind(apex)` として直接代入しているため、apex 本体を変更せずに
// resolveObject / resolveUnknown / resolveReferences のすべてに反映できる (→ ADR-0032)。
apex.requestObject = safeRequestObject.bind(apex);

// net/activity.js の inboxSideEffects (:195-196) と outboxSideEffects (:296-297) が
// res.app.emit で発火させるイベントのペイロード。outbox 側には recipient が存在しない
// (受信者ではなく送信者の actor だけが分かる) → ADR-0022。
export interface ApexInboxMessage {
	actor: APObject;
	activity: APObject;
	recipient: APObject;
	object: APObject | undefined;
}

export interface ApexOutboxMessage {
	actor: APObject;
	activity: APObject;
	object: APObject | undefined;
}

// apex は Express の Application を EventEmitter として使って apex-inbox / apex-outbox を
// 発火させるが、express の型定義に emit イベント名は含まれていないため `as unknown as
// EventEmitter` が必要になる。その cast をここに閉じ込め、購読側は型付きで書けるようにする。
export const onApexInbox = (app: Express, listener: (message: ApexInboxMessage) => unknown) => {
	(app as unknown as EventEmitter).on('apex-inbox', listener);
};

export const onApexOutbox = (app: Express, listener: (message: ApexOutboxMessage) => unknown) => {
	(app as unknown as EventEmitter).on('apex-outbox', listener);
};
