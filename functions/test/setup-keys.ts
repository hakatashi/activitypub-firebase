import { vi } from 'vitest';
import { createMockGenerateKeyPair } from './helpers/mock-keys.js';

vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	const mockedGenerateKeyPair = createMockGenerateKeyPair(actual.generateKeyPair);

	return {
		...actual,
		default: {
			...actual,
			generateKeyPair: mockedGenerateKeyPair,
		},
		generateKeyPair: mockedGenerateKeyPair,
	};
});

vi.mock('crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('crypto')>();
	const mockedGenerateKeyPair = createMockGenerateKeyPair(actual.generateKeyPair);

	return {
		...actual,
		default: {
			...actual,
			generateKeyPair: mockedGenerateKeyPair,
		},
		generateKeyPair: mockedGenerateKeyPair,
	};
});
