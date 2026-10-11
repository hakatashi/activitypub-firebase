import assert from 'node:assert';
import { apex } from '../apex.js';
import type { APObject } from '../apex/index.js';
import { localActorId } from '../localActor.js';
import { isLocalHost, parseUrl, resolveRemoteActor } from './remoteResolution.js';
import { fetchWebfinger } from '../webfinger.js';
import { isAPActor } from '../utils.js';

const ACCT_PATTERN = /^@?(?<username>[^@\s/]+)@(?<host>[^@\s/]+)$/u;

export class AliasError extends Error {
	readonly status: number;

	constructor(message: string, status: number = 400) {
		super(message);
		this.name = 'AliasError';
		this.status = status;
	}
}

export const getAliasesFromActor = (actor: APObject): string[] => {
	const raw = actor.alsoKnownAs;
	if (Array.isArray(raw)) {
		return raw.filter((item): item is string => typeof item === 'string');
	}
	if (typeof raw === 'string') {
		return [raw];
	}
	return [];
};

export const getAccountAliases = async (): Promise<string[]> => {
	const actor = await apex.store.getObject(localActorId);
	if (actor === undefined) {
		return [];
	}
	return getAliasesFromActor(actor);
};

export const resolveAliasTarget = async (input: string): Promise<string> => {
	const trimmed = input.trim().replace(/^acct:/, '');
	if (trimmed.length === 0) {
		throw new AliasError('Alias cannot be empty', 400);
	}

	let targetIri: string;

	if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
		const parsed = parseUrl(trimmed);
		if (parsed === undefined) {
			throw new AliasError(`Invalid URL: ${trimmed}`, 400);
		}
		if (isLocalHost(parsed.host)) {
			throw new AliasError('Cannot set local actor as alias', 400);
		}
		targetIri = parsed.href;
	} else {
		const match = ACCT_PATTERN.exec(trimmed);
		if (!match?.groups) {
			throw new AliasError(
				`Invalid acct format: "${trimmed}". Expected "user@domain" or URL.`,
				400,
			);
		}
		const { username, host } = match.groups;
		assert(username !== undefined && host !== undefined);
		if (isLocalHost(host)) {
			throw new AliasError('Cannot set local actor as alias', 400);
		}
		const webfingerIri = await fetchWebfinger(username, host);
		if (webfingerIri === undefined) {
			throw new AliasError(`WebFinger resolution failed for ${username}@${host}`, 404);
		}
		targetIri = webfingerIri;
	}

	if (targetIri === localActorId) {
		throw new AliasError('Cannot set self as alias', 400);
	}

	const remoteActor = await resolveRemoteActor(targetIri);
	if (remoteActor === undefined || !isAPActor(remoteActor) || remoteActor.id !== targetIri) {
		throw new AliasError(`Target actor could not be resolved or is invalid: ${targetIri}`, 404);
	}

	return targetIri;
};

export const addAccountAlias = async (
	input: string,
): Promise<{ added: string; aliases: string[] }> => {
	const targetIri = await resolveAliasTarget(input);

	const actor = await apex.store.getObject(localActorId);
	const actorWithMeta = await apex.store.getObject(localActorId, true);
	assert(actor !== undefined, 'Local actor not found');
	assert(actorWithMeta !== undefined, 'Local actor with meta not found');

	const currentAliases = getAliasesFromActor(actor);
	if (currentAliases.includes(targetIri)) {
		return { added: targetIri, aliases: currentAliases };
	}

	const updatedAliases = [...currentAliases, targetIri];
	actor.alsoKnownAs = updatedAliases;

	await apex.store.saveObject(actor);
	await apex.publishUpdate(actorWithMeta, actor);

	return { added: targetIri, aliases: updatedAliases };
};

export const removeAccountAlias = async (
	input: string,
): Promise<{ removed: string; aliases: string[] }> => {
	const trimmed = input.trim();
	if (trimmed.length === 0) {
		throw new AliasError('Alias cannot be empty', 400);
	}

	const actor = await apex.store.getObject(localActorId);
	const actorWithMeta = await apex.store.getObject(localActorId, true);
	assert(actor !== undefined, 'Local actor not found');
	assert(actorWithMeta !== undefined, 'Local actor with meta not found');

	const currentAliases = getAliasesFromActor(actor);

	let targetIri = currentAliases.find((item) => item === trimmed);
	if (targetIri === undefined) {
		try {
			const resolved = await resolveAliasTarget(trimmed);
			targetIri = currentAliases.find((item) => item === resolved);
		} catch {
			// Ignore resolution error during removal
		}
	}

	if (targetIri === undefined) {
		throw new AliasError(`Alias "${trimmed}" not found on account`, 404);
	}

	const updatedAliases = currentAliases.filter((item) => item !== targetIri);
	if (updatedAliases.length > 0) {
		actor.alsoKnownAs = updatedAliases;
	} else {
		delete actor.alsoKnownAs;
	}

	await apex.store.saveObject(actor);
	await apex.publishUpdate(actorWithMeta, actor);

	return { removed: targetIri, aliases: updatedAliases };
};
