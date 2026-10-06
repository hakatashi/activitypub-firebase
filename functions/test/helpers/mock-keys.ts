import type * as cryptoType from 'node:crypto';
import util from 'node:util';
import { TEST_KEY_PAIRS } from '../fixtures/keys.js';
import type { TestKeyPair } from '../fixtures/keys.js';

let keyIndex = 0;
let keyGenCallCount = 0;
let lastKeyGenOptions: unknown = null;
let lastKeyGenType: string | null = null;

export const getNextTestKeyPair = (): TestKeyPair => {
	const pair = TEST_KEY_PAIRS[keyIndex % TEST_KEY_PAIRS.length]!;
	keyIndex += 1;
	keyGenCallCount += 1;
	return pair;
};

export const getMockKeyGenCallCount = (): number => keyGenCallCount;

export const getLastKeyGenCall = (): { type: string | null; options: unknown } => ({
	type: lastKeyGenType,
	options: lastKeyGenOptions,
});

export const resetMockKeyStats = (): void => {
	keyIndex = 0;
	keyGenCallCount = 0;
	lastKeyGenOptions = null;
	lastKeyGenType = null;
};

type GenerateKeyPairCallback = (
	err: Error | null,
	publicKey?: unknown,
	privateKey?: unknown,
) => void;

type MockGenerateKeyPair = {
	(type: string, options: unknown, callback?: GenerateKeyPairCallback): void;
	[util.promisify.custom]: (type: string, options: unknown) => Promise<unknown>;
};

export const createMockGenerateKeyPair = (
	actualGenerateKeyPair: typeof cryptoType.generateKeyPair,
): MockGenerateKeyPair => {
	const mockFn = ((type: string, options: unknown, callback?: GenerateKeyPairCallback): void => {
		const cb = typeof options === 'function' ? (options as GenerateKeyPairCallback) : callback;
		const opts = typeof options === 'function' ? undefined : options;

		lastKeyGenType = type;
		lastKeyGenOptions = opts;

		if (type === 'rsa') {
			const pair = getNextTestKeyPair();
			if (cb) {
				process.nextTick(() => cb(null, pair.publicKey, pair.privateKey));
			}
			return;
		}

		actualGenerateKeyPair(type as never, options as never, callback as never);
	}) as MockGenerateKeyPair;

	mockFn[util.promisify.custom] = async (type: string, options: unknown) => {
		lastKeyGenType = type;
		lastKeyGenOptions = options;

		if (type === 'rsa') {
			return getNextTestKeyPair();
		}

		const actualPromise = util.promisify(actualGenerateKeyPair);
		return await actualPromise(type as never, options as never);
	};

	return mockFn;
};
