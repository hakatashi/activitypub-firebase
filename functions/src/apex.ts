import type { ApexInboxMessage, ApexOutboxMessage, RemoteFetchPolicy } from './apex/index.js';
import ActivitypubExpress, { onApexEvent } from './apex/index.js';
import type { Express } from 'express';
import { logger } from 'firebase-functions/v2';
import { domain } from './firebase.js';
import { localActorId } from './localActor.js';
import { routes } from './routes.js';
import Store from './store/index.js';

export { routes };

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
	nodeInfoMetadata: {
		nodeName: '博多市',
		name: '博多市',
	},
	context: [
		{
			toot: 'http://joinmastodon.org/ns#',
			blurhash: 'toot:blurhash',
			focalPoint: { '@container': '@list', '@id': 'toot:focalPoint' },
		},
	],
});

export type { ApexInboxMessage, ApexOutboxMessage };

export const onApexInbox = (app: Express, listener: (message: ApexInboxMessage) => unknown) => {
	onApexEvent(app, 'apex-inbox', listener);
};

export const onApexOutbox = (app: Express, listener: (message: ApexOutboxMessage) => unknown) => {
	onApexEvent(app, 'apex-outbox', listener);
};

// 外部への GET に HTTP Signatures で署名するための systemUser を、ローカル actor から遅延して読み込む。
// Authorized Fetch のサーバー (mastodon.social など) は署名のない取得に 401 を返す (→ ADR-0098)。
export const ensureSystemUser = async () => {
	if (apex.systemUser !== undefined) {
		return;
	}
	const actor = await apex.store.getObject(localActorId, true);
	if (typeof actor?._meta?.privateKey === 'string') {
		// eslint-disable-next-line require-atomic-updates
		apex.systemUser = actor;
	}
};
