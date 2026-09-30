// express middleware
import * as activity from './activity.js';
import * as collection from './collection.js';
import * as responders from './responders.js';
import * as security from './security.js';
import * as validators from './validators.js';
import * as wellKnown from './well-known.js';

export default {
	validators,
	responders,
	security,
	activity,
	collection,
	wellKnown,
	// meta - colletions of middleware to complete activitypub actions
	activityStream: {
		get: [
			validators.jsonld,
			validators.targetActivity,
			security.verifyAuthorization,
			security.requireAuthorizedOrPublic,
			responders.target,
		],
	},
	actor: {
		get: [validators.jsonld, validators.targetActor, responders.target],
	},
	blocked: {
		get: [
			validators.jsonld,
			validators.targetActor,
			security.verifyAuthorization,
			collection.blocked,
			responders.result,
		],
	},
	collections: {
		get: [
			validators.jsonld,
			validators.targetActor,
			security.verifyAuthorization,
			collection.added,
			responders.result,
		],
	},
	followers: {
		get: [
			validators.jsonld,
			validators.targetActorWithMeta,
			security.verifyAuthorization,
			collection.followers,
			responders.result,
		],
	},
	following: {
		get: [
			validators.jsonld,
			validators.targetActor,
			security.verifyAuthorization,
			collection.following,
			responders.result,
		],
	},
	inbox: {
		post: [
			validators.jsonld,
			validators.targetActorWithMeta,
			security.verifySignature,
			validators.actor,
			validators.activityObject,
			validators.inboxActivity,
			activity.save,
			activity.resolveThread,
			activity.inboxSideEffects,
			activity.forwardFromInbox,
			responders.status,
		],
		get: [
			validators.jsonld,
			validators.targetActorWithMeta,
			security.verifyAuthorization,
			collection.inbox,
			responders.result,
		],
	},
	liked: {
		get: [
			validators.jsonld,
			validators.targetActor,
			security.verifyAuthorization,
			collection.liked,
			responders.result,
		],
	},
	shares: {
		get: [
			validators.jsonld,
			validators.targetActivity,
			security.verifyAuthorization,
			collection.shares,
			responders.result,
		],
	},
	likes: {
		get: [
			validators.jsonld,
			validators.targetActivity,
			security.verifyAuthorization,
			collection.likes,
			responders.result,
		],
	},
	object: {
		get: [
			validators.jsonld,
			validators.targetObject,
			security.verifyAuthorization,
			security.requireAuthorizedOrPublic,
			responders.target,
		],
	},
	outbox: {
		post: [
			validators.jsonld,
			validators.targetActorWithMeta,
			security.verifyAuthorization,
			security.requireAuthorized,
			validators.outboxCreate,
			validators.outboxActivityObject,
			validators.outboxActivity,
			activity.save,
			activity.outboxSideEffects,
			responders.status,
		],
		get: [
			validators.jsonld,
			validators.targetActor,
			security.verifyAuthorization,
			collection.outbox,
			responders.result,
		],
	},
	rejected: {
		get: [
			validators.jsonld,
			validators.targetActor,
			security.verifyAuthorization,
			collection.rejected,
			responders.result,
		],
	},
	rejections: {
		get: [
			validators.jsonld,
			validators.targetActor,
			security.verifyAuthorization,
			collection.rejections,
			responders.result,
		],
	},
	webfinger: {
		get: [wellKnown.parseWebfinger, validators.targetActor, wellKnown.respondWebfinger],
	},
	nodeInfo: {
		get: [wellKnown.respondNodeInfo],
	},
	nodeInfoLocation: {
		get: [wellKnown.respondNodeInfoLocation],
	},
	proxy: {
		post: [validators.jsonld, validators.targetProxied, responders.target],
	},
};
