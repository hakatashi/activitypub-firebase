// @ts-expect-error: Not typed
import ActivitypubExpress from 'activitypub-express';
import express from 'express';
import {https, logger, params} from 'firebase-functions/v2';
import {domain, mastodonDomain} from './firebase.js';
import Store from './store.js';

const hakatashiToken = params.defineSecret('HAKATASHI_TOKEN');

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

const adminOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
	if (process.env.FUNCTIONS_EMULATOR === 'true') {
		next();
		return;
	}
	if (req.headers['x-hakatashi-token'] === hakatashiToken.value()) {
		next();
		return;
	}
	res.status(403).send('Forbidden');
};

const apex = ActivitypubExpress({
	name: 'activitypub-firebase',
	version: '1.0.0',
	domain,
	actorParam: 'actor',
	objectParam: 'id',
	activityParam: 'id',
	logger,
	routes,
	store: new Store(),
	endpoints: {
		proxyUrl: `https://${domain}/activitypub/proxy`,
	},
	nodeInfoMetadata: {
		nodeName: '博多市',
		name: '博多市',
	},
});

app.use((req, res, next) => {
	// Default express.json() parser doesn't properly work with cloud functions
	if (apex.consts.jsonldTypes.includes(req.headers['content-type']) && req.body) {
		req.body = JSON.parse(req.body);
	}

	logger.info({
		type: 'request',
		method: req.method,
		path: req.path,
		headers: req.headers,
		body: req.body,
	});

	// Required to make the HTTP signature verification work
	req.headers.host = domain;

	next();
});

app.use(
	express.json(),
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

app.get(routes.actor, (req: express.Request, res: express.Response) => {
	const actor = req.params.actor;
	if (typeof actor !== 'string') {
		res.status(400).send('Actor is not specified');
		return;
	}
	res.redirect(`https://elk.zone/${mastodonDomain}/@${actor}@${domain}`);
});

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
app.get('/activitypub/createAdmin', adminOnly, async (req: express.Request, res: express.Response) => {
	const actor = await apex.createActor('hakatashi', 'hakatashi', '博多市です。', 'https://raw.githubusercontent.com/hakatashi/icon/master/images/icon_480px.png', 'Person');
	await apex.store.setup(actor);
	// eslint-disable-next-line require-atomic-updates
	apex.systemUser = actor;
	res.json(actor);
});
app.post('/activitypub/createPost', adminOnly, async (req: express.Request, res: express.Response) => {
	const text = req.body?.text;
	if (typeof text !== 'string') {
		res.status(400).send('Text is not correct type');
		return;
	}

	const url = apex.utils.objectIdToIRI();
	const published = new Date().toISOString();
	const actorId = `https://${domain}/activitypub/u/hakatashi`;
	const actor = await apex.store.getObject(actorId, true);
	const followersId = `https://${domain}/activitypub/u/hakatashi/followers`;
	const object = {
		id: url,
		url,
		published,
		type: 'Note',
		attributedTo: actor.id,
		to: followersId,
		cc: 'as:Public',
		content: text,
	};

	await apex.store.saveObject(object);
	const message = await apex.buildActivity('Create', actor.id, followersId, {
		cc: 'as:Public',
		object,
		published,
	});

	logger.info({type: 'createPostMessage', message});

	const result = await apex.addToOutbox(actor, message);

	logger.info({type: 'createPostAddToOutboxResult', result});

	res.send('ok');
});
app.get('/activitypub/publishProfileUpdate', adminOnly, async (req: express.Request, res: express.Response) => {
	const actorId = `https://${domain}/activitypub/u/hakatashi`;
	const actor = await apex.store.getObject(actorId);
	const actorWithMeta = await apex.store.getObject(actorId, true);
	await apex.publishUpdate(actorWithMeta, actor);
	res.json('ok');
});

app.on('apex-outbox', (message: any) => {
	logger.info({type: 'outbox', message});

	if (message.activity.type === 'Create') {
		logger.info(`New ${message.object.type} from ${message.actor}`);
	}
});

app.on('apex-inbox', async (message: any) => {
	logger.info({type: 'inbox', message});

	// Auto-accept follow
	if (message.activity.type === 'Follow') {
		logger.info(`New follow request from ${message.actor.id}`);

		const object = {...message.activity};
		// eslint-disable-next-line no-underscore-dangle, private-props/no-use-outside
		delete object._meta;

		const accept = await apex.buildActivity('Accept', message.recipient.id, message.actor.id, {
			object,
		});
		const {postTask: publishUpdatedFollowers} = await apex.acceptFollow(message.recipient, message.activity);

		logger.info(`Accepting follow request from ${message.actor.id}`);
		await apex.addToOutbox(message.recipient, accept);

		logger.info('Publishing updated followers');
		await publishUpdatedFollowers();

		logger.info(`Follow request from ${message.actor.id} accepted`);

		return;
	}

	if (message.activity.type === 'Create') {
		logger.info(`New ${message.object.type} from ${message.actor} to ${message.recipient}`);
	}
});

// Hook into res.send and execute postWork tasks manually
const originalSend = express.response.send;
express.response.send = function (body) {
	(async () => {
		const apexLocal = this.locals.apex;
		if (apexLocal) {
			logger.info({
				type: 'response',
				status: this.statusCode,
				headers: this.getHeaders(),
				body,
				locals: apexLocal,
			});

			try {
				// execute postWork tasks in sequence (not parallel)
				await apexLocal.postWork.reduce(
					(acc: Promise<void>, task: (res: express.Response) => Promise<void>) => (
						acc.then(() => task(this))
					),
					Promise.resolve(),
				);

				// eslint-disable-next-line require-atomic-updates
				apexLocal.postWork = [];

				if (apexLocal.eventName) {
					await Promise.all(
						this.app.listeners(apexLocal.eventName)
							.map((listener) => listener.call(this.app, apexLocal.eventMessage)),
					);
					// eslint-disable-next-line require-atomic-updates
					apexLocal.eventName = null;
				}
			} catch (err: any) {
				logger.error('post-response error:', err.message);
				logger.error(err);
			}
		}

		originalSend.call(this, body);
	})();

	return this;
};


export const activitypub = https.onRequest({secrets: [hakatashiToken]}, app);

export {apex};
