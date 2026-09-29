import type { EventEmitter } from 'node:events';
import type { APObject, RemoteFetchPolicy } from './apex/index.js';
import ActivitypubExpress from './apex/index.js';
import type { Express } from 'express';
import { logger } from 'firebase-functions/v2';
import { domain } from './firebase.js';
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

// エミュレータ/テストは実際に localhost のモックサーバーへ到達する必要があるため http と
// ループバックを許可する。dev projectId にデプロイされた本物の Cloud Functions は本番同様
// クラウド上で動くので許可しない。テストが process.env を書き換えて切り替えられるよう
// 取得のたびに評価する (→ ADR-0050)。
const remoteFetchPolicy = (): RemoteFetchPolicy => {
	const isLocalDevelopment =
		process.env.FUNCTIONS_EMULATOR === 'true' || process.env.NODE_ENV === 'test';
	return isLocalDevelopment
		? { allowedProtocols: ['https:', 'http:'], allowedRanges: ['unicast', 'loopback'] }
		: {};
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
	remoteFetchPolicy,
	endpoints: {
		proxyUrl: `https://${domain}/activitypub/proxy`,
	},
	nodeInfoMetadata: {
		nodeName: '博多市',
		name: '博多市',
	},
});

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
