import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { apex } from '../../src/apex.js';
import { deliveryTask, isRetriableDeliveryStatusCode, pingTask } from '../../src/tasks.js';

import { resetFirestore } from '../helpers/index.js';
import { getDelivery } from '../../src/store/deliveries.js';

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
		await apex.store.saveObject({
			id: actorId,
			type: 'Person',
			preferredUsername: 'hakatashi',
			_meta: { privateKey: 'test-private-key' },
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await resetFirestore();
	});

	test('does nothing on a 2xx response', async () => {
		const deliverSpy = vi
			.spyOn(apex, 'deliver')
			.mockResolvedValue({ statusCode: 202, headers: {} });

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).resolves.toBeUndefined();

		expect(deliverSpy).toHaveBeenCalledWith(
			`${actorId}#main-key`,
			body,
			address,
			'test-private-key',
		);
		expect(await getDelivery(activityId, address)).toMatchObject({
			status: 'success',
			attempts: 1,
			statusCode: 202,
			error: null,
		});
	});

	test.each([400, 403, 404, 410, 422])(
		'discards the task without throwing on a permanent-failure %i response',
		async (statusCode) => {
			vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode, headers: {} });

			await expect(
				deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
			).resolves.toBeUndefined();

			expect(await getDelivery(activityId, address)).toMatchObject({
				status: 'permanent_failure',
				attempts: 1,
				statusCode,
			});
		},
	);

	test.each([401, 408, 429])(
		'throws to trigger a retry on a transient %i response',
		async (statusCode) => {
			vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode, headers: {} });

			await expect(
				deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
			).rejects.toThrow(`Delivery to ${address} failed with status ${statusCode}`);

			expect(await getDelivery(activityId, address)).toMatchObject({
				status: 'retrying',
				attempts: 1,
				statusCode,
			});
		},
	);

	test('logs rate limit info and retries when a 429 response includes retry-after header', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({
			statusCode: 429,
			headers: { 'retry-after': '60' },
		});

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).rejects.toThrow(`Delivery to ${address} failed with status 429`);

		expect(await getDelivery(activityId, address)).toMatchObject({
			status: 'retrying',
			attempts: 1,
			statusCode: 429,
		});
	});

	test('throws to trigger a retry on a 5xx response', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode: 503, headers: {} });

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).rejects.toThrow();

		expect(await getDelivery(activityId, address)).toMatchObject({
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

		expect(await getDelivery(activityId, address)).toMatchObject({
			status: 'retrying',
			attempts: 1,
			statusCode: null,
			error: 'ETIMEDOUT',
		});
	});

	test('uses Cloud Tasks retryCount to compute the attempt number', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue({ statusCode: 503, headers: {} });

		await expect(
			deliveryTask.run(
				makeDeliveryTaskRequest({ data: { actorId, body, address }, retryCount: 2 }),
			),
		).rejects.toThrow();

		expect(await getDelivery(activityId, address)).toMatchObject({ attempts: 3 });
	});

	test('does nothing when apex.deliver returns null (localhost address in production)', async () => {
		vi.spyOn(apex, 'deliver').mockResolvedValue(null);

		await expect(
			deliveryTask.run(makeDeliveryTaskRequest({ data: { actorId, body, address } })),
		).resolves.toBeUndefined();

		expect(await getDelivery(activityId, address)).toBeUndefined();
	});

	test('does nothing when the actor cannot be found', async () => {
		const deliverSpy = vi
			.spyOn(apex, 'deliver')
			.mockResolvedValue({ statusCode: 202, headers: {} });

		await expect(
			deliveryTask.run(
				makeDeliveryTaskRequest({
					data: { actorId: 'https://example.com/activitypub/u/unknown', body, address },
				}),
			),
		).resolves.toBeUndefined();

		expect(deliverSpy).not.toHaveBeenCalled();
		expect(await getDelivery(activityId, address)).toBeUndefined();
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

describe('isRetriableDeliveryStatusCode', () => {
	test('returns true for transient 4xx status codes (401, 408, 429)', () => {
		expect(isRetriableDeliveryStatusCode(401)).toBe(true);
		expect(isRetriableDeliveryStatusCode(408)).toBe(true);
		expect(isRetriableDeliveryStatusCode(429)).toBe(true);
	});

	test('returns true for 5xx status codes', () => {
		expect(isRetriableDeliveryStatusCode(500)).toBe(true);
		expect(isRetriableDeliveryStatusCode(502)).toBe(true);
		expect(isRetriableDeliveryStatusCode(503)).toBe(true);
		expect(isRetriableDeliveryStatusCode(504)).toBe(true);
	});

	test('returns false for permanent failure 4xx status codes', () => {
		expect(isRetriableDeliveryStatusCode(400)).toBe(false);
		expect(isRetriableDeliveryStatusCode(403)).toBe(false);
		expect(isRetriableDeliveryStatusCode(404)).toBe(false);
		expect(isRetriableDeliveryStatusCode(410)).toBe(false);
		expect(isRetriableDeliveryStatusCode(422)).toBe(false);
	});

	test('returns false for 2xx status codes', () => {
		expect(isRetriableDeliveryStatusCode(200)).toBe(false);
		expect(isRetriableDeliveryStatusCode(202)).toBe(false);
	});
});
