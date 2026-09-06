import type { APActorWithMeta } from 'activitypub-express';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';
import { apex } from './apex.js';

const pingTaskPayloadSchema = z.object({
	message: z.string(),
});

export const pingTask = onTaskDispatched<unknown>(
	{ retryConfig: { maxAttempts: 1 } },
	(request) => {
		const parsed = pingTaskPayloadSchema.safeParse(request.data);
		if (!parsed.success) {
			logger.error({
				type: 'pingTaskInvalidPayload',
				error: parsed.error,
				data: request.data,
			});
			return;
		}
		logger.info({ type: 'pingTaskReceived', message: parsed.data.message });
	},
);

export const enqueuePingTask = async (message: string) => {
	await getFunctions().taskQueue('pingTask').enqueue({ message });
};

const deliveryTaskPayloadSchema = z.object({
	actorId: z.string().min(1),
	body: z.string().min(1),
	address: z.string().min(1),
});

const activityBodySchema = z.object({
	id: z.string().min(1),
});

// apex.deliver は request-promise-native の `simple: false` で呼ばれ、
// 4xx/5xx でも例外を投げずレスポンスを返す。ステータスコードごとに
// リトライすべきか(throw して Cloud Tasks に任せる)、恒久失敗として
// 破棄すべきか(正常終了する)を判定する。ネットワークエラー/タイムアウトは
// apex.deliver 自体が reject するため、結果を記録してからそのまま
// Cloud Tasks の再試行に委ねる(ADR-0012)。
export const deliveryTask = onTaskDispatched<unknown>(
	{
		retryConfig: {
			maxAttempts: 5,
			minBackoffSeconds: 10,
			maxBackoffSeconds: 3600,
			maxDoublings: 4,
		},
		rateLimits: {
			maxConcurrentDispatches: 10,
			maxDispatchesPerSecond: 5,
		},
		// apex.requestTimeout(既定5秒)より十分長く取り、
		// タイムアウトの取り合いにならないようにする
		timeoutSeconds: 60,
	},
	async (request) => {
		const parsedPayload = deliveryTaskPayloadSchema.safeParse(request.data);
		if (!parsedPayload.success) {
			logger.error({
				type: 'deliveryTaskInvalidPayload',
				error: parsedPayload.error,
				data: request.data,
			});
			return;
		}

		const { actorId, body, address } = parsedPayload.data;
		// Cloud Tasks の初回実行では 0。ADR-0012: Firestore 上の試行回数として使う
		const attempts = (request.retryCount ?? 0) + 1;

		let activityId: string;
		try {
			const parsedJson: unknown = JSON.parse(body);
			const parsedBody = activityBodySchema.safeParse(parsedJson);
			if (!parsedBody.success) {
				logger.error({
					type: 'deliveryTaskInvalidBody',
					error: parsedBody.error,
					actorId,
					address,
				});
				return;
			}
			activityId = parsedBody.data.id;
		} catch (err: unknown) {
			logger.error({
				type: 'deliveryTaskInvalidJsonBody',
				error: err instanceof Error ? err.message : String(err),
				actorId,
				address,
			});
			return;
		}

		logger.info({ type: 'deliveryTaskReceived', actorId, address, attempts });

		const actor = await apex.store.getObject(actorId, true);
		if (!actor) {
			logger.error({ type: 'deliveryTaskActorNotFound', actorId });
			return;
		}

		let result;
		try {
			// HTTP Signature の keyId には公開鍵の id (`${actorId}#main-key`, apex `pub/actor.js`)
			// を渡す必要がある。actorId をそのまま渡すと本家 Mastodon 側の鍵解決が失敗する
			// (→ ADR-0015)
			result = await apex.deliver(
				`${actorId}#main-key`,
				body,
				address,
				(actor as APActorWithMeta)._meta.privateKey,
			);
		} catch (err: any) {
			await apex.store.recordDeliveryResult({
				activityId,
				actorId,
				address,
				body,
				attempts,
				status: 'retrying',
				error: err?.message ?? String(err),
			});
			throw err;
		}

		// 本番環境で address が localhost の場合、apex.deliver は null を返す
		if (result === null) {
			logger.info({ type: 'deliveryTaskSkippedLocalAddress', actorId, address });
			return;
		}

		logger.info({
			type: 'deliveryTaskResult',
			actorId,
			address,
			statusCode: result.statusCode,
		});

		if (result.statusCode >= 200 && result.statusCode < 300) {
			await apex.store.recordDeliveryResult({
				activityId,
				actorId,
				address,
				body,
				attempts,
				status: 'success',
				statusCode: result.statusCode,
			});
			return;
		}

		if (result.statusCode < 500) {
			logger.warn({
				type: 'deliveryTaskPermanentFailure',
				actorId,
				address,
				statusCode: result.statusCode,
			});
			await apex.store.recordDeliveryResult({
				activityId,
				actorId,
				address,
				body,
				attempts,
				status: 'permanent_failure',
				statusCode: result.statusCode,
			});
			return;
		}

		await apex.store.recordDeliveryResult({
			activityId,
			actorId,
			address,
			body,
			attempts,
			status: 'retrying',
			statusCode: result.statusCode,
			error: `Delivery to ${address} failed with status ${result.statusCode}`,
		});
		throw new Error(`Delivery to ${address} failed with status ${result.statusCode}`);
	},
);
