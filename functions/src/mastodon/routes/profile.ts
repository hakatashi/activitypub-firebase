import express from 'express';
import assert from 'node:assert';
import { apex } from '../../apex.js';
import { escapeFirestoreKey } from '../../firebase.js';
import { UserInfos } from '../../schema.js';
import { deleteStorageFileByUrl } from '../../storage/media.js';
import { getImageUrl } from '../../utils.js';
import { authRequired, getAuthActorId, scopeRequired } from '../http/auth.js';
import { loadViewer } from '../http/loaders.js';
import { accountToCredentialAccount, actorObjectToAccount } from '../presenters/account.js';

const router = express.Router();

router.delete(
	'/v1/profile/avatar',
	authRequired,
	scopeRequired('write:accounts'),
	async (req, res) => {
		const actorId = getAuthActorId(res);
		const actor = await loadViewer(res);

		const userInfoRef = UserInfos.doc(escapeFirestoreKey(actorId));
		const userInfoDoc = await userInfoRef.get();
		assert(userInfoDoc.exists, 'userInfoDoc does not exist');

		const oldUrl = getImageUrl(actor.icon);
		if (typeof oldUrl === 'string') {
			await deleteStorageFileByUrl(oldUrl);
		}

		delete actor.icon;

		await apex.store.saveObject(actor);

		const actorWithMeta = await apex.store.getObject(actorId, true);
		assert(actorWithMeta !== undefined, 'actorWithMeta is undefined');
		await apex.publishUpdate(actorWithMeta, actor);

		const userInfo = userInfoDoc.data();
		assert(userInfo !== undefined, 'userInfo is undefined');
		const account = await actorObjectToAccount(actor, userInfo);
		res.json(accountToCredentialAccount(account, userInfo));
	},
);

router.delete(
	'/v1/profile/header',
	authRequired,
	scopeRequired('write:accounts'),
	async (req, res) => {
		const actorId = getAuthActorId(res);
		const actor = await loadViewer(res);

		const userInfoRef = UserInfos.doc(escapeFirestoreKey(actorId));
		const userInfoDoc = await userInfoRef.get();
		assert(userInfoDoc.exists, 'userInfoDoc does not exist');

		const oldUrl = getImageUrl(actor.image);
		if (typeof oldUrl === 'string') {
			await deleteStorageFileByUrl(oldUrl);
		}

		delete actor.image;

		await apex.store.saveObject(actor);

		const actorWithMeta = await apex.store.getObject(actorId, true);
		assert(actorWithMeta !== undefined, 'actorWithMeta is undefined');
		await apex.publishUpdate(actorWithMeta, actor);

		const userInfo = userInfoDoc.data();
		assert(userInfo !== undefined, 'userInfo is undefined');
		const account = await actorObjectToAccount(actor, userInfo);
		res.json(accountToCredentialAccount(account, userInfo));
	},
);

export default router;
