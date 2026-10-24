import assert from 'node:assert';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { APObject } from './apex/types.js';
import Store from './store/index.js';

const generateKeyPairPromise = promisify(crypto.generateKeyPair);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Returns the next keyId with an incremented generation number (→ ADR-0161).
 *
 * Pattern:
 * - `${actorId}#main-key` -> `${actorId}#main-key-2`
 * - `${actorId}#main-key-2` -> `${actorId}#main-key-3`
 * - `${actorId}#main-key-N` -> `${actorId}#main-key-${N+1}`
 * - `${actorId}#custom` -> `${actorId}#custom-2`
 * - undefined or without fragment -> `${actorId}#main-key-2`
 */
export const getNextKeyId = (currentKeyId: string | undefined, actorId: string): string => {
	if (!currentKeyId) {
		return `${actorId}#main-key-2`;
	}
	const hashIndex = currentKeyId.indexOf('#');
	if (hashIndex < 0) {
		return `${currentKeyId}#main-key-2`;
	}
	const base = currentKeyId.slice(0, hashIndex);
	const fragment = currentKeyId.slice(hashIndex + 1);

	const match = fragment.match(/^main-key(?:-(?<gen>\d+))?$/);
	if (match) {
		const genStr = match.groups?.gen;
		const currentGen = genStr === undefined ? 1 : parseInt(genStr, 10);
		return `${base}#main-key-${currentGen + 1}`;
	}
	return `${base}#${fragment}-2`;
};

export interface RotateActorKeyOptions {
	actorId: string;
	customKeyId?: string | undefined;
	dryRun?: boolean | undefined;
	store?: Store | undefined;
}

export interface RotateActorKeyResult {
	actorId: string;
	oldKeyId: string | undefined;
	newKeyId: string;
	publicKeyPem: string;
	rotatedActor: APObject;
}

export const rotateActorKey = async (
	options: RotateActorKeyOptions,
): Promise<RotateActorKeyResult> => {
	const { actorId, customKeyId, dryRun = false } = options;
	const store = options.store ?? new Store();

	const actor = await store.getObject(actorId, true);
	assert(actor, `actor not found: ${actorId}`);
	assert(typeof actor._meta?.privateKey === 'string', 'actor has no existing private key');

	// apex は fromJSONLD() で actor を JSON-LD 展開形に正規化して保存するため、
	// publicKey は単一オブジェクトではなく1要素の配列、publicKeyPem もその中で
	// 配列になっていることがある (functions/src/apex/pub/utils.ts)。
	// 将来の実装変化に備え、配列/非配列どちらの形でも動くようにしておく。
	const currentPublicKeyEntry = Array.isArray(actor.publicKey)
		? actor.publicKey[0]
		: actor.publicKey;
	assert(currentPublicKeyEntry, 'actor has no existing public key');

	const rawCurrentKeyId = isRecord(currentPublicKeyEntry) ? currentPublicKeyEntry.id : undefined;
	const currentKeyId = Array.isArray(rawCurrentKeyId) ? rawCurrentKeyId[0] : rawCurrentKeyId;
	const currentKeyIdStr = typeof currentKeyId === 'string' ? currentKeyId : undefined;

	const currentPublicKeyPem = isRecord(currentPublicKeyEntry)
		? currentPublicKeyEntry.publicKeyPem
		: undefined;
	assert(currentPublicKeyPem !== undefined, 'actor has no existing public key pem');
	const publicKeyPemIsArray = Array.isArray(currentPublicKeyPem);
	const keyIdIsArray = Array.isArray(rawCurrentKeyId);

	const newKeyId = customKeyId ?? getNextKeyId(currentKeyIdStr, actorId);

	// apex の createActor と同じパラメータで生成する (functions/src/apex/pub/actor.ts)
	const { publicKey, privateKey } = await generateKeyPairPromise('rsa', {
		modulusLength: 4096,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	const newPublicKeyEntry = {
		...(isRecord(currentPublicKeyEntry) ? currentPublicKeyEntry : {}),
		id: keyIdIsArray ? [newKeyId] : newKeyId,
		publicKeyPem: publicKeyPemIsArray ? [publicKey] : publicKey,
	};

	const rotatedActor: APObject = {
		...actor,
		id: actorId,
		publicKey: Array.isArray(actor.publicKey) ? [newPublicKeyEntry] : newPublicKeyEntry,
		_meta: {
			...actor._meta,
			privateKey,
		},
	};

	if (!dryRun) {
		await store.updateObject(rotatedActor, actorId, true);
	}

	return {
		actorId,
		oldKeyId: currentKeyIdStr,
		newKeyId,
		publicKeyPem: publicKey,
		rotatedActor,
	};
};
