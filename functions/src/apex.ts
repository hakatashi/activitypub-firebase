// @ts-expect-error: Not typed
import ActivitypubExpress from 'activitypub-express';
import {logger} from 'firebase-functions/v2';
import {domain} from './firebase.js';
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
