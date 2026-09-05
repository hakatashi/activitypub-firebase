import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {apex} from '../../src/apex.js';
import {deliveryTask} from '../../src/tasks.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const actorId = 'https://example.com/activitypub/u/hakatashi';
const address = 'https://remote.example/u/alice/inbox';
const activityId = 'https://example.com/activitypub/activities/1';
const body = `{"id":"${activityId}","type":"Create"}`;

describe('deliveryTask', () => {
	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		await apex.store.saveObject({
			id: actorId,
			type: 'Person',
			preferredUsername: 'hakatashi',
			_meta: {privateKey: 'test-private-key'},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fetch(
			`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
			{
				method: 'DELETE',
			},
		);
	});

	test('does nothing on a 2xx response', async () => {
		const deliverSpy = vi.spyOn(apex, 'deliver').mockResolvedValue({statusCode: 202});

		await expect(deliveryTask.run({data: {actorId, body, address}} as any)).resolves.toBeUndefined();

		expect(deliverSpy).toHaveBeenCalledWith(`${actorId}#main-key`, body, address, 'test-private-key');
		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'success', attempts: 1, statusCode: 202, error: null,
		});
	});

	test('discards the task without throwing on a permanent-failure 4xx response', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({statusCode: 410});

		await expect(deliveryTask.run({data: {actorId, body, address}} as any)).resolves.toBeUndefined();

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'permanent_failure', attempts: 1, statusCode: 410,
		});
	});

	test('throws to trigger a retry on a 5xx response', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({statusCode: 503});

		await expect(deliveryTask.run({data: {actorId, body, address}} as any)).rejects.toThrow();

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'retrying', attempts: 1, statusCode: 503,
		});
	});

	test('propagates a network error so Cloud Tasks retries', async () => {
		vi.spyOn(apex, 'deliver').mockRejectedValue(new Error('ETIMEDOUT'));

		await expect(deliveryTask.run({data: {actorId, body, address}} as any)).rejects.toThrow('ETIMEDOUT');

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'retrying', attempts: 1, statusCode: null, error: 'ETIMEDOUT',
		});
	});

	test('uses Cloud Tasks retryCount to compute the attempt number', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({statusCode: 503});

		await expect(deliveryTask.run({data: {actorId, body, address}, retryCount: 2} as any)).rejects.toThrow();

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({attempts: 3});
	});

	test('does nothing when apex.deliver returns null (localhost address in production)', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue(null);

		await expect(deliveryTask.run({data: {actorId, body, address}} as any)).resolves.toBeUndefined();

		expect(await apex.store.getDelivery(activityId, address)).toBeUndefined();
	});

	test('does nothing when the actor cannot be found', async () => {
		const deliverSpy = vi.spyOn(apex, 'deliver').mockResolvedValue({statusCode: 202});

		await expect(deliveryTask.run({
			data: {actorId: 'https://example.com/activitypub/u/unknown', body, address},
		} as any)).resolves.toBeUndefined();

		expect(deliverSpy).not.toHaveBeenCalled();
		expect(await apex.store.getDelivery(activityId, address)).toBeUndefined();
	});
});
