// @ts-expect-error: Not typed
import * as ActivitypubExpress from 'activitypub-express';
import * as express from 'express';
import {https, logger} from 'firebase-functions/v2';
import Store from './store';

const app = express();
const routes = {
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

const apex = ActivitypubExpress({
	name: 'HakataFediverse',
	version: '1.0.0',
	domain: 'hakatashi.com',
	actorParam: 'actor',
	objectParam: 'id',
	activityParam: 'id',
	routes,
	endpoints: {
		proxyUrl: 'https://hakatashi.com/activitypub/proxy',
	},
});

apex.store = new Store();

// Default express.json() parser doesn't properly work with cloud functions
app.use((req, res, next) => {
	if (apex.consts.jsonldTypes.includes(req.headers['content-type']) && req.body) {
		req.body = JSON.parse(req.body);
	}
	logger.info({
		method: req.method,
		path: req.path,
		headers: req.headers,
		body: req.body,
	});
	req.headers.host = 'hakatashi.com';
	next();
});

app.use(
	express.urlencoded({extended: true}),
	apex,
);

app.route(routes.inbox)
	.get(apex.net.inbox.get)
	.post(apex.net.inbox.post);
app.route(routes.outbox)
	.get(apex.net.outbox.get)
	.post(apex.net.outbox.post);
app.get(routes.actor, apex.net.actor.get);
app.get(routes.followers, apex.net.followers.get);
app.get(routes.following, apex.net.following.get);
app.get(routes.liked, apex.net.liked.get);
app.get(routes.object, apex.net.object.get);
app.get(routes.activity, apex.net.activityStream.get);
app.get(routes.shares, apex.net.shares.get);
app.get(routes.likes, apex.net.likes.get);
app.get('/.well-known/webfinger', apex.net.webfinger.get);
app.get('/.well-known/nodeinfo', apex.net.nodeInfoLocation.get);
app.get('/nodeinfo/:version', apex.net.nodeInfo.get);
app.post('/activitypub/proxy', apex.net.proxy.post);

app.get('/activitypub/createAdmin', async (req: express.Request, res: express.Response) => {
	const actor = await apex.createActor('hakatashi', 'hakatashi', '博多市です。', 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png', 'Person');
	await apex.store.setup(actor);
	// eslint-disable-next-line require-atomic-updates
	apex.systemUser = actor;
	res.json(actor);
});

app.on('apex-outbox', (msg: any) => {
	if (msg.activity.type === 'Create') {
		logger.info(`New ${msg.object.type} from ${msg.actor}`);
	}
});
app.on('apex-inbox', (msg: any) => {
	if (msg.activity.type === 'Create') {
		logger.info(`New ${msg.object.type} from ${msg.actor} to ${msg.recipient}`);
	}
});

export const handler = https.onRequest(app);
