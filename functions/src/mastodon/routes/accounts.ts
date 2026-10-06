import assert from 'node:assert';
import { z } from 'zod';
import { apex } from '../../apex.js';
import { getFollowerActorIris, getFollowing } from '../../social/follows.js';
import { escapeFirestoreKey, toFirestoreKey, unescapeFirestoreKey } from '../../firebase.js';
import { plainTextToHtml } from '../../notes.js';
import { Streams, UserInfo, UserInfos } from '../../schema.js';
import { toIdArray } from '../../utils.js';
import { createAsyncRouter } from '../http/asyncRouter.js';
import { authRequired, getLocalActor, getOptionalViewer, scopeRequired } from '../http/auth.js';
import { toBoolean } from '../http/params.js';
import { respondWithStatuses, setLinkHeader, unprocessable } from '../http/responses.js';
import { parsePageParams } from '../pagination.js';
import {
	FOLLOWERS_PAGE_LIMITS,
	accountToCredentialAccount,
	actorObjectToAccount,
	assertIsAPActor,
	getAccount,
	getFollowersPage,
	getFollowingPage,
	getRelationships,
	resolveAccountActor,
} from '../presenters/account.js';
import type { RelationshipEntity } from '../presenters/account.js';
import { STATUS_PAGE_LIMITS, getAccountStatuses } from '../presenters/status.js';

const router = createAsyncRouter();

export const accountLookupQuerySchema = z.object({
	acct: z.string().min(1),
});

export const accountParamsSchema = z.object({
	id: z.string().min(1),
});

export const relationshipsQuerySchema = z.object({
	id: z
		.union([z.string(), z.array(z.string())])
		.transform((val) => (Array.isArray(val) ? val : [val])),
});

export const updateCredentialsBodySchema = z.object({
	display_name: z.string().optional(),
	note: z.string().optional(),
	avatar: z.unknown().optional(),
	header: z.unknown().optional(),
	locked: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
	bot: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
	discoverable: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
	fields_attributes: z
		.union([
			z.array(z.object({ name: z.string(), value: z.string() })),
			z.record(z.string(), z.object({ name: z.string(), value: z.string() })),
		])
		.optional(),
	source: z
		.object({
			privacy: z.enum(['public', 'unlisted', 'private', 'direct']).optional(),
			sensitive: z.union([z.boolean(), z.string()]).transform(toBoolean).optional(),
			language: z.string().optional(),
		})
		.optional(),
});

router.get('/v1/accounts/lookup', async (req, res) => {
	const parsedQuery = accountLookupQuerySchema.safeParse(req.query);
	if (!parsedQuery.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const account = await getAccount(parsedQuery.data.acct);

	if (account === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	res.json(account);
});

router.get(
	'/v1/accounts/relationships',
	authRequired,
	scopeRequired('read:follows'),
	async (req, res) => {
		const parsedQuery = relationshipsQuerySchema.safeParse(req.query);
		if (!parsedQuery.success) {
			res.json([]);
			return;
		}

		const viewer = await getLocalActor(res.locals.actorId as string);
		const relationships = await getRelationships(viewer, parsedQuery.data.id);
		res.json(relationships);
	},
);

router.get('/v1/accounts/verify_credentials', authRequired, async (req, res) => {
	const actorId = res.locals.actorId as string;
	const actor = await getLocalActor(actorId);
	const userInfo = res.locals.auth as UserInfo;
	const account = await actorObjectToAccount(actor, userInfo);
	res.json(accountToCredentialAccount(account, userInfo));
});

router.patch(
	'/v1/accounts/update_credentials',
	authRequired,
	scopeRequired('write:accounts'),
	async (req, res) => {
		const parsedBody = updateCredentialsBodySchema.safeParse(req.body ?? {});
		if (!parsedBody.success) {
			unprocessable(res, `Validation failed: ${parsedBody.error.issues[0]?.message ?? 'invalid'}`);
			return;
		}
		const body = parsedBody.data;

		const actorId = res.locals.actorId as string;
		const actor = await apex.store.getObject(actorId, true);
		assertIsAPActor(actor);

		const userInfoRef = UserInfos.doc(escapeFirestoreKey(actorId));
		const userInfoDoc = await userInfoRef.get();
		assert(userInfoDoc.exists, 'userInfoDoc does not exist');
		const userUpdates: Partial<UserInfo> = {};

		if (body.display_name !== undefined) {
			actor.name = body.display_name;
		}
		if (body.note !== undefined) {
			actor.summary = plainTextToHtml(body.note);
		}
		if (body.locked !== undefined) {
			actor.manuallyApprovesFollowers = body.locked;
			userUpdates.locked = body.locked;
		}
		if (body.bot !== undefined) {
			userUpdates.bot = body.bot;
		}
		if (body.discoverable !== undefined) {
			actor.discoverable = body.discoverable;
		}
		if (body.fields_attributes !== undefined) {
			const fieldsList = Array.isArray(body.fields_attributes)
				? body.fields_attributes
				: Object.values(body.fields_attributes);
			const fields = fieldsList.map((f) => ({
				name: f.name,
				value: f.value,
				verified_at: null,
			}));
			userUpdates.fields = fields;
			actor.attachment = fields.map((f) => ({
				type: 'PropertyValue',
				name: f.name,
				value: f.value,
			}));
		}

		if (Object.keys(userUpdates).length > 0) {
			await userInfoRef.update(userUpdates);
		}

		await apex.store.saveObject(actor);

		const actorWithMeta = await apex.store.getObject(actorId, true);
		assert(actorWithMeta !== undefined, 'actorWithMeta is undefined');
		await apex.publishUpdate(actorWithMeta, actor);

		const updatedUserInfo = (await userInfoRef.get()).data();
		assert(updatedUserInfo !== undefined, 'updatedUserInfo is undefined');
		const updatedAccount = await actorObjectToAccount(actor, updatedUserInfo);
		res.json(accountToCredentialAccount(updatedAccount, updatedUserInfo));
	},
);

router.get('/v1/accounts/:id/statuses', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	// ローカル (UserInfos の id) とリモート (Mastodon ID の採番) の両方を解決する (→ ADR-0069)
	const resolved = await resolveAccountActor(parsedParams.data.id);
	if (resolved === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}
	const actorId = resolved.actor.id;
	assert(actorId !== undefined, 'actor.id is undefined');

	// 認証は任意。トークンがあれば閲覧者として可視性を判定する。
	const viewer = await getOptionalViewer(req, res);
	const isPinned = typeof req.query.pinned === 'string' && toBoolean(req.query.pinned) === true;
	respondWithStatuses(
		req,
		res,
		await getAccountStatuses(actorId, viewer, parsePageParams(req.query, STATUS_PAGE_LIMITS), {
			pinned: isPinned,
		}),
	);
});

router.get('/v1/accounts/:id/followers', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfo = await UserInfos.where('id', '==', parsedParams.data.id).get();

	if (userInfo.docs.length !== 1) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfoDoc = userInfo.docs[0];
	assert(userInfoDoc !== undefined);

	const userId = unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id));
	const actorObject = await apex.store.getObject(userId);

	if (actorObject === undefined) {
		res.sendStatus(500);
		return;
	}
	assertIsAPActor(actorObject);

	const { accounts, cursorIds } = await getFollowersPage(
		actorObject,
		parsePageParams(req.query, FOLLOWERS_PAGE_LIMITS),
	);
	setLinkHeader(req, res, cursorIds);
	res.json(accounts);
});

router.get('/v1/accounts/:id/following', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfo = await UserInfos.where('id', '==', parsedParams.data.id).get();
	if (userInfo.docs.length !== 1) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const userInfoDoc = userInfo.docs[0];
	assert(userInfoDoc !== undefined);

	const userId = unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id));
	const actorObject = await apex.store.getObject(userId);

	if (actorObject === undefined) {
		res.sendStatus(500);
		return;
	}
	assertIsAPActor(actorObject);

	const { accounts, cursorIds } = await getFollowingPage(
		actorObject,
		parsePageParams(req.query, FOLLOWERS_PAGE_LIMITS),
	);
	setLinkHeader(req, res, cursorIds);
	res.json(accounts);
});

router.post(
	'/v1/accounts/:id/follow',
	authRequired,
	scopeRequired('write:follows'),
	async (req, res) => {
		const parsedParams = accountParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const resolved = await resolveAccountActor(parsedParams.data.id);
		if (resolved === undefined) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const targetActor = resolved.actor;
		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		if (targetActor.id === actor.id) {
			unprocessable(res, 'You cannot follow yourself');
			return;
		}

		const followingSet = new Set(await getFollowing(actor));
		const isAlreadyFollowing = followingSet.has(targetActor.id);

		if (!isAlreadyFollowing) {
			const activity = await apex.buildActivity('Follow', actor.id, targetActor.id, {
				object: targetActor.id,
			});
			await apex.addToOutbox(actor, activity);
			// following コレクションを匿名にも公開するため (→ ADR-0035, ADR-0075)。
			await apex.store.markActivityPublic(activity);
		}

		const isTargetLocked =
			targetActor.manuallyApprovesFollowers === true || resolved.userInfo?.locked === true;
		const followerIris = await getFollowerActorIris(actor);
		const relationship: RelationshipEntity = {
			id: parsedParams.data.id,
			following: !isTargetLocked,
			showing_reblogs: !isTargetLocked,
			notifying: false,
			languages: [],
			followed_by: followerIris.includes(targetActor.id),
			blocking: false,
			blocked_by: false,
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
			requested: isTargetLocked,
			requested_by: false,
			domain_blocking: false,
			endorsed: false,
			note: '',
		};

		res.json(relationship);
	},
);

router.post(
	'/v1/accounts/:id/unfollow',
	authRequired,
	scopeRequired('write:follows'),
	async (req, res) => {
		const parsedParams = accountParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const resolved = await resolveAccountActor(parsedParams.data.id);
		if (resolved === undefined) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const targetActor = resolved.actor;
		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		if (targetActor.id === actor.id) {
			unprocessable(res, 'You cannot unfollow yourself');
			return;
		}

		const followingIri = toIdArray(actor.following)[0];
		let follow = followingIri
			? await apex.store.findActivityByCollectionAndObjectId(followingIri, targetActor.id, true)
			: undefined;
		if (follow === undefined) {
			const outboxIri = toIdArray(actor.outbox)[0];
			if (outboxIri) {
				follow = await apex.store.findActivityByCollectionAndObjectId(
					outboxIri,
					targetActor.id,
					true,
				);
			}
		}
		if (follow === undefined) {
			const followDocs = await Streams.where('type', '==', 'Follow')
				.where('actor', 'array-contains', actor.id)
				.get();
			follow = followDocs.docs
				.map((doc) => doc.data())
				.find((act) => toIdArray(act.object).includes(targetActor.id));
		}

		if (follow !== undefined) {
			const cleanFollow = { ...follow };
			delete cleanFollow._meta;
			const undoActivity = await apex.buildActivity('Undo', actor.id, targetActor.id, {
				object: cleanFollow,
			});
			await apex.addToOutbox(actor, undoActivity);
			await apex.store.removeActivity(follow, actor.id);
		}

		const followerIris = await getFollowerActorIris(actor);
		const relationship: RelationshipEntity = {
			id: parsedParams.data.id,
			following: false,
			showing_reblogs: false,
			notifying: false,
			languages: [],
			followed_by: followerIris.includes(targetActor.id),
			blocking: false,
			blocked_by: false,
			muting: false,
			muting_notifications: false,
			muting_expires_at: null,
			requested: false,
			requested_by: false,
			domain_blocking: false,
			endorsed: false,
			note: '',
		};

		res.json(relationship);
	},
);

router.get('/v1/accounts/:id', async (req, res) => {
	const parsedParams = accountParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const resolved = await resolveAccountActor(parsedParams.data.id);
	if (resolved === undefined) {
		res.status(404).json({
			error: 'Record not found',
		});
		return;
	}

	const account = await actorObjectToAccount(
		resolved.actor,
		resolved.userInfo,
		parsedParams.data.id,
	);
	res.json(account);
});

export default router;
