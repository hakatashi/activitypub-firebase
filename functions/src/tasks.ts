import {getFunctions} from 'firebase-admin/functions';
import {logger} from 'firebase-functions/v2';
import {onTaskDispatched} from 'firebase-functions/v2/tasks';
import {apex} from './apex.js';

interface PingTaskPayload {
	message: string;
}

export const pingTask = onTaskDispatched<PingTaskPayload>(
	{retryConfig: {maxAttempts: 1}},
	(request) => {
		logger.info({type: 'pingTaskReceived', message: request.data.message});
	},
);

export const enqueuePingTask = async (message: string) => {
	await getFunctions().taskQueue('pingTask').enqueue({message});
};

interface DeliveryTaskPayload {
	actorId: string;
	body: string;
	address: string;
}

// apex.deliver は request-promise-native の `simple: false` で呼ばれ、
// 4xx/5xx でも例外を投げずレスポンスを返す。ステータスコードごとに
// リトライすべきか(throw して Cloud Tasks に任せる)、恒久失敗として
// 破棄すべきか(正常終了する)を判定する。ネットワークエラー/タイムアウトは
// apex.deliver 自体が reject するため、ここでは捕捉せずそのまま
// Cloud Tasks の再試行に委ねる。
export const deliveryTask = onTaskDispatched<DeliveryTaskPayload>(
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
		const {actorId, body, address} = request.data;

		logger.info({type: 'deliveryTaskReceived', actorId, address});

		const actor = await apex.store.getObject(actorId, true);
		if (!actor) {
			logger.error({type: 'deliveryTaskActorNotFound', actorId});
			return;
		}

		const result = await apex.deliver(actorId, body, address, actor._meta.privateKey);

		// 本番環境で address が localhost の場合、apex.deliver は null を返す
		if (result === null) {
			logger.info({type: 'deliveryTaskSkippedLocalAddress', actorId, address});
			return;
		}

		logger.info({
			type: 'deliveryTaskResult',
			actorId,
			address,
			statusCode: result.statusCode,
		});

		if (result.statusCode >= 200 && result.statusCode < 300) {
			return;
		}

		if (result.statusCode < 500) {
			logger.warn({
				type: 'deliveryTaskPermanentFailure',
				actorId,
				address,
				statusCode: result.statusCode,
			});
			return;
		}

		throw new Error(`Delivery to ${address} failed with status ${result.statusCode}`);
	},
);
