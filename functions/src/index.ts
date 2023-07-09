// @ts-expect-error: Not typed
import * as ActivitypubExpress from 'activitypub-express';
import * as express from 'express';
import {https} from 'firebase-functions';
import Store from './store';

// // Start writing functions
// // https://firebase.google.com/docs/functions/typescript
//
// export const helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

const app = express();
const routes = {
	actor: '/u/:actor',
	object: '/o/:id',
	activity: '/s/:id',
	inbox: '/u/:actor/inbox',
	outbox: '/u/:actor/outbox',
	followers: '/u/:actor/followers',
	following: '/u/:actor/following',
	liked: '/u/:actor/liked',
	collections: '/u/:actor/c/:id',
	blocked: '/u/:actor/blocked',
	rejections: '/u/:actor/rejections',
	rejected: '/u/:actor/rejected',
	shares: '/s/:id/shares',
	likes: '/s/:id/likes',
};

const apex = ActivitypubExpress({
	name: 'Apex Example',
	version: '1.0.0',
	domain: 'localhost',
	actorParam: 'actor',
	objectParam: 'id',
	activityParam: 'id',
	routes,
	endpoints: {
		proxyUrl: 'https://localhost/proxy',
	},
});

app.use(
	express.json({type: apex.consts.jsonldTypes}),
	express.urlencoded({extended: true}),
	apex,
);
// define routes using prepacakged middleware collections
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
app.post('/proxy', apex.net.proxy.post);

app.on('apex-outbox', (msg: any) => {
	if (msg.activity.type === 'Create') {
		console.log(`New ${msg.object.type} from ${msg.actor}`);
	}
});
app.on('apex-inbox', (msg: any) => {
	if (msg.activity.type === 'Create') {
		console.log(`New ${msg.object.type} from ${msg.actor} to ${msg.recipient}`);
	}
});

apex.store = new Store();

export const handler = https.onRequest(app);
