import express from 'express';
import assert from 'node:assert';
import qs from 'qs';
import { z } from 'zod';
import { apex } from '../../apex.js';
import { getFollowFlags, getFollowIri } from '../../social/follows.js';
import { escapeFirestoreKey, toFirestoreKey, unescapeFirestoreKey } from '../../firebase.js';
import { assignMediaMastodonId } from '../../mastodonId.js';
import { plainTextToHtml } from '../../notes.js';
import { UserInfo, UserInfos } from '../../schema.js';
import { deleteStorageFileByUrl, uploadProfileImage } from '../../storage/media.js';
import { getImageUrl, toIdArray } from '../../utils.js';
import {
	authRequired,
	getAuthActorId,
	getAuthUserInfo,
	getLocalActor,
	getOptionalViewer,
	scopeRequired,
} from '../http/auth.js';
import { NotFoundError, UnprocessableError } from '../http/errors.js';
import { loadAccount, loadViewer } from '../http/loaders.js';
import { parseMultipart } from '../http/multipart.js';
import type { MultipartFile } from '../http/multipart.js';
import { idParamSchema, toBoolean } from '../http/params.js';
import { respondWithStatuses, setLinkHeader } from '../http/responses.js';
import { getValidParams, getValidQuery, validate } from '../http/validation.js';
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
} from '../presenters/account.js';
import type { RelationshipEntity } from '../presenters/account.js';
import { STATUS_PAGE_LIMITS, getAccountStatuses } from '../presenters/status.js';
import { markActivityPublic } from '../../store/activities.js';
import { requestRemoteActorRefreshIfStale } from '../../social/remoteActorCounts.js';

const router = express.Router();

export const accountLookupQuerySchema = z.object({
	acct: z.string().min(1),
});

export const accountParamsSchema = idParamSchema;

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

router.get(
	'/v1/accounts/lookup',
	validate({ query: accountLookupQuerySchema, statusCodes: { query: 404 } }),
	async (req, res) => {
		const { acct } = getValidQuery(res, accountLookupQuerySchema);
		const account = await getAccount(acct);
		if (account === undefined) {
			throw new NotFoundError();
		}
		res.json(account);
	},
);

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

		const viewer = await getLocalActor(getAuthActorId(res));
		const relationships = await getRelationships(viewer, parsedQuery.data.id);
		res.json(relationships);
	},
);

router.get('/v1/accounts/verify_credentials', authRequired, async (req, res) => {
	const actorId = getAuthActorId(res);
	const actor = await getLocalActor(actorId);
	const userInfo = getAuthUserInfo(res);
	const account = await actorObjectToAccount(actor, userInfo);
	res.json(accountToCredentialAccount(account, userInfo));
});

router.patch(
	'/v1/accounts/update_credentials',
	authRequired,
	scopeRequired('write:accounts'),
	async (req, res) => {
		let bodyInput: unknown = req.body;
		let avatarFile: MultipartFile | undefined;
		let headerFile: MultipartFile | undefined;

		const contentType = req.headers['content-type']?.toLowerCase() ?? '';
		if (contentType.includes('multipart/form-data')) {
			const { files, fields } = await parseMultipart(req);
			avatarFile = files.avatar;
			headerFile = files.header;

			const qsStr = new URLSearchParams(fields).toString();
			bodyInput = qs.parse(qsStr);
		}

		const parsed = updateCredentialsBodySchema.safeParse(bodyInput);
		if (!parsed.success) {
			throw new UnprocessableError(
				parsed.error.issues.map((issue) => issue.message).join(', ') || 'Validation failed',
			);
		}
		const body = parsed.data;

		const actorId = getAuthActorId(res);
		const actor = await loadViewer(res);

		const userInfoRef = UserInfos.doc(escapeFirestoreKey(actorId));
		const userInfoDoc = await userInfoRef.get();
		assert(userInfoDoc.exists, 'userInfoDoc does not exist');
		const userUpdates: Partial<UserInfo> = {};

		if (avatarFile && avatarFile.buffer.length > 0) {
			const { processProfileImage } = await import('../profileImage.js');
			const processed = await processProfileImage(avatarFile.buffer, 'avatar');
			const fileId = await assignMediaMastodonId();
			const uploaded = await uploadProfileImage({
				type: 'avatar',
				id: fileId,
				buffer: processed.buffer,
				mimeType: processed.mimeType,
				extension: processed.extension,
			});
			const oldUrl = getImageUrl(actor.icon);
			if (typeof oldUrl === 'string') {
				await deleteStorageFileByUrl(oldUrl);
			}
			actor.icon = {
				type: 'Image',
				mediaType: processed.mimeType,
				url: uploaded.url,
			};
		}

		if (headerFile && headerFile.buffer.length > 0) {
			const { processProfileImage } = await import('../profileImage.js');
			const processed = await processProfileImage(headerFile.buffer, 'header');
			const fileId = await assignMediaMastodonId();
			const uploaded = await uploadProfileImage({
				type: 'header',
				id: fileId,
				buffer: processed.buffer,
				mimeType: processed.mimeType,
				extension: processed.extension,
			});
			const oldUrl = getImageUrl(actor.image);
			if (typeof oldUrl === 'string') {
				await deleteStorageFileByUrl(oldUrl);
			}
			actor.image = {
				type: 'Image',
				mediaType: processed.mimeType,
				url: uploaded.url,
			};
		}

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
	// ローカル (UserInfos の id) とリモート (Mastodon ID の採番) の両方を解決する (→ ADR-0069)
	const resolved = await loadAccount(req.params.id);
	const actorId = resolved.actor.id;
	assert(actorId !== undefined, 'actor.id is undefined');

	// 認証は任意。トークンがあれば閲覧者として可視性を判定する。
	const viewer = await getOptionalViewer(req, res);
	const isPinned = typeof req.query.pinned === 'string' && toBoolean(req.query.pinned) === true;
	const excludeReblogs =
		typeof req.query.exclude_reblogs === 'string' && toBoolean(req.query.exclude_reblogs) === true;
	respondWithStatuses(
		req,
		res,
		await getAccountStatuses(actorId, viewer, parsePageParams(req.query, STATUS_PAGE_LIMITS), {
			pinned: isPinned,
			excludeReblogs,
		}),
	);
});

router.get(
	'/v1/accounts/:id/followers',
	validate({ params: accountParamsSchema }),
	async (req, res) => {
		const { id } = getValidParams(res, accountParamsSchema);

		const userInfo = await UserInfos.where('id', '==', id).get();

		if (userInfo.docs.length !== 1) {
			throw new NotFoundError();
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
	},
);

router.get(
	'/v1/accounts/:id/following',
	validate({ params: accountParamsSchema }),
	async (req, res) => {
		const { id } = getValidParams(res, accountParamsSchema);

		const userInfo = await UserInfos.where('id', '==', id).get();
		if (userInfo.docs.length !== 1) {
			throw new NotFoundError();
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
	},
);

router.post(
	'/v1/accounts/:id/follow',
	authRequired,
	scopeRequired('write:follows'),
	validate({ params: accountParamsSchema }),
	async (req, res) => {
		const { id } = getValidParams(res, accountParamsSchema);
		const resolved = await loadAccount(id);
		const targetActor = resolved.actor;
		const actor = await loadViewer(res);

		if (targetActor.id === actor.id) {
			throw new UnprocessableError('You cannot follow yourself');
		}

		const [flags] = await getFollowFlags(actor, [targetActor.id]);
		assert(flags !== undefined);

		if (!flags.following) {
			const activity = await apex.buildActivity('Follow', actor.id, targetActor.id, {
				object: targetActor.id,
			});
			await apex.addToOutbox(actor, activity);
			// following コレクションを匿名にも公開するため (→ ADR-0035, ADR-0075)。
			await markActivityPublic(activity);
		}

		const isTargetLocked =
			targetActor.manuallyApprovesFollowers === true || resolved.userInfo?.locked === true;
		const relationship: RelationshipEntity = {
			id,
			following: !isTargetLocked,
			showing_reblogs: !isTargetLocked,
			notifying: false,
			languages: [],
			followed_by: flags.followedBy,
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
	validate({ params: accountParamsSchema }),
	async (req, res) => {
		const { id } = getValidParams(res, accountParamsSchema);
		const resolved = await loadAccount(id);
		const targetActor = resolved.actor;
		const actor = await loadViewer(res);

		if (targetActor.id === actor.id) {
			throw new UnprocessableError('You cannot unfollow yourself');
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
			// streams の Follow を全件読まず、フォロー関係の射影から引く (→ ADR-0083)。
			const followIri = await getFollowIri(actor, targetActor.id);
			if (followIri !== undefined) {
				follow = await apex.store.getActivity(followIri, true);
			}
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

		const [flags] = await getFollowFlags(actor, [targetActor.id]);
		assert(flags !== undefined);
		const relationship: RelationshipEntity = {
			id,
			following: false,
			showing_reblogs: false,
			notifying: false,
			languages: [],
			followed_by: flags.followedBy,
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
	const resolved = await loadAccount(req.params.id);
	if (resolved.userInfo === undefined) {
		await requestRemoteActorRefreshIfStale(resolved.actor);
	}
	const account = await actorObjectToAccount(
		resolved.actor,
		resolved.userInfo,
		req.params.id ?? '',
	);
	res.json(account);
});

export default router;
