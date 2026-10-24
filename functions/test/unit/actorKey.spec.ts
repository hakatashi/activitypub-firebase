import crypto from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getNextKeyId, rotateActorKey } from '../../src/actorKey.js';
import type Store from '../../src/store/index.js';

describe('actorKey', () => {
	const actorId = 'https://example.com/activitypub/u/hakatashi';

	describe('getNextKeyId', () => {
		test('generates #main-key-2 for undefined or missing fragment', () => {
			expect(getNextKeyId(undefined, actorId)).toBe(`${actorId}#main-key-2`);
			expect(getNextKeyId('', actorId)).toBe(`${actorId}#main-key-2`);
			expect(getNextKeyId(actorId, actorId)).toBe(`${actorId}#main-key-2`);
		});

		test('generates #main-key-2 from #main-key', () => {
			expect(getNextKeyId(`${actorId}#main-key`, actorId)).toBe(`${actorId}#main-key-2`);
		});

		test('increments generation numbers', () => {
			expect(getNextKeyId(`${actorId}#main-key-2`, actorId)).toBe(`${actorId}#main-key-3`);
			expect(getNextKeyId(`${actorId}#main-key-3`, actorId)).toBe(`${actorId}#main-key-4`);
			expect(getNextKeyId(`${actorId}#main-key-10`, actorId)).toBe(`${actorId}#main-key-11`);
		});

		test('handles non-main-key fragments', () => {
			expect(getNextKeyId(`${actorId}#custom-key`, actorId)).toBe(`${actorId}#custom-key-2`);
		});
	});

	describe('rotateActorKey', () => {
		const mockStore = {
			getObject: vi.fn(),
			updateObject: vi.fn(),
		} as unknown as Store;

		beforeEach(() => {
			vi.clearAllMocks();
		});

		test('throws if actor is not found', async () => {
			vi.mocked(mockStore.getObject).mockResolvedValue(undefined);
			await expect(rotateActorKey({ actorId, store: mockStore })).rejects.toThrow(
				`actor not found: ${actorId}`,
			);
		});

		test('throws if actor has no private key', async () => {
			vi.mocked(mockStore.getObject).mockResolvedValue({
				id: actorId,
				type: 'Person',
			});
			await expect(rotateActorKey({ actorId, store: mockStore })).rejects.toThrow(
				'actor has no existing private key',
			);
		});

		test('rotates key from #main-key to #main-key-2 and saves to store', async () => {
			const initialActor = {
				id: actorId,
				type: 'Person',
				publicKey: {
					id: `${actorId}#main-key`,
					owner: actorId,
					publicKeyPem: 'old-public-key',
				},
				_meta: {
					privateKey: 'old-private-key',
				},
			};
			vi.mocked(mockStore.getObject).mockResolvedValue(initialActor);
			vi.mocked(mockStore.updateObject).mockImplementation((obj) => Promise.resolve(obj));

			const result = await rotateActorKey({ actorId, store: mockStore });

			expect(result.actorId).toBe(actorId);
			expect(result.oldKeyId).toBe(`${actorId}#main-key`);
			expect(result.newKeyId).toBe(`${actorId}#main-key-2`);
			expect(result.publicKeyPem).toContain('BEGIN PUBLIC KEY');

			expect(mockStore.updateObject).toHaveBeenCalledOnce();
			const savedActor = vi.mocked(mockStore.updateObject).mock.calls[0]![0];
			expect(savedActor.publicKey).toMatchObject({
				id: `${actorId}#main-key-2`,
				publicKeyPem: result.publicKeyPem,
			});
			expect(savedActor._meta?.privateKey).toBeDefined();

			// Verify that the private key and public key actually form a valid RSA pair
			const payload = Buffer.from('test');
			const signature = crypto.sign('sha256', payload, savedActor._meta!.privateKey as string);
			const verified = crypto.verify('sha256', payload, result.publicKeyPem, signature);
			expect(verified).toBe(true);
		});

		test('preserves JSON-LD array structure if actor has array publicKey/publicKeyPem', async () => {
			const initialActor = {
				id: actorId,
				type: 'Person',
				publicKey: [
					{
						id: [`${actorId}#main-key-2`],
						owner: [actorId],
						publicKeyPem: ['old-public-key'],
					},
				],
				_meta: {
					privateKey: 'old-private-key',
				},
			};
			vi.mocked(mockStore.getObject).mockResolvedValue(initialActor);
			vi.mocked(mockStore.updateObject).mockImplementation((obj) => Promise.resolve(obj));

			const result = await rotateActorKey({ actorId, store: mockStore });

			expect(result.oldKeyId).toBe(`${actorId}#main-key-2`);
			expect(result.newKeyId).toBe(`${actorId}#main-key-3`);

			const savedActor = vi.mocked(mockStore.updateObject).mock.calls[0]![0];
			expect(Array.isArray(savedActor.publicKey)).toBe(true);
			const keyEntry = (savedActor.publicKey as unknown[])[0] as {
				id: unknown;
				publicKeyPem: unknown;
			};
			expect(keyEntry.id).toEqual([`${actorId}#main-key-3`]);
			expect(keyEntry.publicKeyPem).toEqual([result.publicKeyPem]);
		});

		test('supports customKeyId', async () => {
			const initialActor = {
				id: actorId,
				type: 'Person',
				publicKey: {
					id: `${actorId}#main-key`,
					owner: actorId,
					publicKeyPem: 'old-public-key',
				},
				_meta: {
					privateKey: 'old-private-key',
				},
			};
			vi.mocked(mockStore.getObject).mockResolvedValue(initialActor);
			vi.mocked(mockStore.updateObject).mockImplementation((obj) => Promise.resolve(obj));

			const result = await rotateActorKey({
				actorId,
				customKeyId: `${actorId}#custom-20261024`,
				store: mockStore,
			});

			expect(result.newKeyId).toBe(`${actorId}#custom-20261024`);
			const savedActor = vi.mocked(mockStore.updateObject).mock.calls[0]![0];
			expect(savedActor.publicKey).toMatchObject({
				id: `${actorId}#custom-20261024`,
			});
		});

		test('does not update store when dryRun is true', async () => {
			const initialActor = {
				id: actorId,
				type: 'Person',
				publicKey: {
					id: `${actorId}#main-key`,
					owner: actorId,
					publicKeyPem: 'old-public-key',
				},
				_meta: {
					privateKey: 'old-private-key',
				},
			};
			vi.mocked(mockStore.getObject).mockResolvedValue(initialActor);

			const result = await rotateActorKey({
				actorId,
				dryRun: true,
				store: mockStore,
			});

			expect(result.newKeyId).toBe(`${actorId}#main-key-2`);
			expect(mockStore.updateObject).not.toHaveBeenCalled();
		});
	});
});
