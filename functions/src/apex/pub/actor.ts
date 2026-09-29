import { generateKeyPair } from 'node:crypto';
import { promisify } from 'node:util';
import type { Apex, APObject } from '../types.js';

const generateKeyPairPromise = promisify(generateKeyPair);

export const createActor = async function (
	this: Apex,
	rawUsername: string,
	displayName: string,
	summary: string,
	icon?: unknown,
	type = 'Person',
): Promise<APObject> {
	const username = rawUsername.toLowerCase();
	const id = this.utils.usernameToIRI(username);
	const routes = this.utils.nameToActorStreams(username);
	const pair = await generateKeyPairPromise('rsa', {
		modulusLength: 4096,
		publicKeyEncoding: {
			type: 'spki',
			format: 'pem',
		},
		privateKeyEncoding: {
			type: 'pkcs8',
			format: 'pem',
		},
	});
	const actor: Record<string, unknown> = {
		id,
		type,
		following: routes.following,
		followers: routes.followers,
		liked: routes.liked,
		inbox: routes.inbox,
		outbox: routes.outbox,
		preferredUsername: username,
		name: displayName,
		summary,
		publicKey: {
			id: `${id}#main-key`,
			owner: id,
			publicKeyPem: pair.publicKey,
		},
	};
	if (icon) {
		actor.icon = icon;
	}
	if (this.settings.endpoints) {
		actor.endpoints = {
			id: `${id}#endpoints`,
			...this.settings.endpoints,
		};
	}
	const compacted = await this.fromJSONLD(actor);
	if (!compacted) {
		throw new TypeError(`Failed to build actor ${id}`);
	}
	compacted._meta = { privateKey: pair.privateKey };
	return compacted;
};
