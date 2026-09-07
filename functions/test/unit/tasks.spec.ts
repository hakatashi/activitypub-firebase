import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { deliveryTask, pingTask } from '../../src/tasks.js';

const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT;

const actorId = 'https://example.com/activitypub/u/hakatashi';
const address = 'https://remote.example/u/alice/inbox';
const activityId = 'https://example.com/activitypub/activities/1';
const body = `{"id":"${activityId}","type":"Create"}`;

const makeDeliveryTaskRequest = (data: unknown) =>
	data as unknown as Parameters<typeof deliveryTask.run>[0];

const makePingTaskRequest = (data: unknown) =>
	data as unknown as Parameters<typeof pingTask.run>[0];

describe('deliveryTask', () => {
	beforeEach(async () => {
		if (firestoreHost === undefined || projectId === undefined) {
			throw new Error('Firestore emulator is not running');
		}
		await apex.store.saveObject({
			id: actorId,
			type: 'Person',
			preferredUsername: 'hakatashi',
			_meta: { privateKey: 'test-private-key' },
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
		const deliverSpy = vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode: 202 });

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).resolves.toBeUndefined();

		expect(deliverSpy).toHaveBeenCalledWith(
			`${actorId}#main-key`,
			body,
			address,
			'test-private-key',
		);
		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'success',
			attempts: 1,
			statusCode: 202,
			error: null,
		});
	});

	test('discards the task without throwing on a permanent-failure 4xx response', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode: 410 });

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).resolves.toBeUndefined();

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'permanent_failure',
			attempts: 1,
			statusCode: 410,
		});
	});

	test('throws to trigger a retry on a 5xx response', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode: 503 });

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).rejects.toThrow();

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'retrying',
			attempts: 1,
			statusCode: 503,
		});
	});

	test('propagates a network error so Cloud Tasks retries', async () => {
		vi.spyOn(apex, 'deliver').mockRejectedValue(new Error('ETIMEDOUT'));

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).rejects.toThrow('ETIMEDOUT');

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({
			status: 'retrying',
			attempts: 1,
			statusCode: null,
			error: 'ETIMEDOUT',
		});
	});

	test('uses Cloud Tasks retryCount to compute the attempt number', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode: 503 });

		await expect(
			deliveryTask.run(
				makeDeliveryTaskRequest({ data: { actorId, body, address }, retryCount: 2 }),
			),
		).rejects.toThrow();

		expect(await apex.store.getDelivery(activityId, address)).toMatchObject({ attempts: 3 });
	});

	test('does nothing when apex.deliver returns null (localhost address in production)', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue(null);

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).resolves.toBeUndefined();

		expect(await apex.store.getDelivery(activityId, address)).toBeUndefined();
	});

	test('does nothing when the actor cannot be found', async () => {
		const deliverSpy = vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode: 202 });

		await expect(
			deliveryTask.run(
				makeDeliveryTaskRequest({
					data: { actorId: 'https://example.com/activitypub/u/unknown', body, address },
				}),
			),
		).resolves.toBeUndefined();

		expect(deliverSpy).not.toHaveBeenCalled();
		expect(await apex.store.getDelivery(activityId, address)).toBeUndefined();
	});

	test('discards the task when payload structure is invalid', async () => {
		const deliverSpy = vi.spyOn(apex, 'deliver');

		// Missing actorId / body / address
		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId } })),
		).resolves.toBeUndefined();

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: null })),
		).resolves.toBeUndefined();

		expect(deliverSpy).not.toHaveBeenCalled();
	});

	test('discards the task when body is invalid JSON or missing activity id', async () => {
		const deliverSpy = vi.spyOn(apex, 'deliver');

		// Malformed JSON
		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body: '{malformed', address } })),
		).resolves.toBeUndefined();

		// JSON without id
		await expect(
			deliveryTask.run(
				makeDeliveryTaskRequest({ data: { actorId, body: '{"type":"Create"}', address } }),
			),
		).resolves.toBeUndefined();

		expect(deliverSpy).not.toHaveBeenCalled();
	});
});

describe('pingTask', () => {
	test('handles valid payload without error', () => {
		expect(() => pingTask.run(makePingTaskRequest({ data: { message: 'hello' } }))).not.toThrow();
	});

	test('handles invalid payload without throwing', () => {
		expect(() => pingTask.run(makePingTaskRequest({ data: { message: 123 } }))).not.toThrow();
		expect(() => pingTask.run(makePingTaskRequest({ data: null }))).not.toThrow();
	});
});
