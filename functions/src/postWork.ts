import type express from 'express';
import { logger } from 'firebase-functions/v2';
import { toError } from './utils.js';

// apex がリクエストごとに `res.locals.apex` へ積む値のうち、ここで扱うもの。
interface ApexLocals {
	postWork?: ((res: express.Response) => unknown)[];
	eventName?: string | null;
	eventMessage?: unknown;
	[key: string]: unknown;
}

const isApexLocals = (value: unknown): value is ApexLocals =>
	typeof value === 'object' && value !== null;

const idOf = (value: unknown) =>
	typeof value === 'object' && value !== null && 'id' in value ? value.id : undefined;

// `res.locals.apex.target` には apex の targetActorWithMeta が入れた `_meta.privateKey` が
// 含まれうるため、locals をそのままログに出さず安全なフィールドだけを抜き出す (ADR-0013)。
const summarizeApexLocals = (apexLocal: ApexLocals) => ({
	status: apexLocal.status,
	responseType: apexLocal.responseType,
	createdLocation: apexLocal.createdLocation,
	eventName: apexLocal.eventName,
	targetId: idOf(apexLocal.target),
	actorId: idOf(apexLocal.actor),
	activityId: idOf(apexLocal.activity),
	objectId: idOf(apexLocal.object),
	postWorkCount: apexLocal.postWork?.length ?? 0,
});

// apex は onFinished(レスポンス送出後)に postWork とイベントを実行するが、
// Cloud Functions ではレスポンス後の CPU 割り当てが保証されず、実行されないまま
// インスタンスが凍結されうる。そのため送出前にここで実行する (ADR-0013)。
// 実行済みの postWork / eventName は落としておき、apex 側の onFinishedHandler で
// 二重に実行されないようにする。
const runPostWork = async (res: express.Response) => {
	const apexLocal = isApexLocals(res.locals.apex) ? res.locals.apex : {};

	const startedAt = Date.now();

	const originalPostWork = apexLocal.postWork ?? [];
	apexLocal.postWork = [];

	// execute postWork tasks in sequence (not parallel)
	await originalPostWork.reduce(
		(acc: Promise<void>, task) =>
			acc.then(async () => {
				await task(res);
			}),
		Promise.resolve(),
	);

	const postWorkFinishedAt = Date.now();

	const { eventName } = apexLocal;
	if (eventName) {
		apexLocal.eventName = null;
		await Promise.all(
			res.app
				.listeners(eventName)
				.map((listener) => listener.call(res.app, apexLocal.eventMessage)),
		);
	}

	const finishedAt = Date.now();

	// postWork の所要時間を継続的に計測するためのログ (ADR-0013)
	logger.info({
		type: 'postWorkCompleted',
		path: res.req?.path,
		taskCount: originalPostWork.length,
		eventName: eventName ?? null,
		postWorkDurationMs: postWorkFinishedAt - startedAt,
		eventDurationMs: finishedAt - postWorkFinishedAt,
		durationMs: finishedAt - startedAt,
	});
};

// `res.send` をリクエストスコープで差し替え、レスポンス送出の直前に postWork と
// apex-inbox / apex-outbox イベントを await する。
// express.response のプロトタイプを書き換えると同一プロセスの mastodonApi まで
// 巻き添えになるため、このミドルウェアを適用した app にだけ効くようにしている (ADR-0013)。
export const runPostWorkBeforeSend: express.RequestHandler = (req, res, next) => {
	const originalSend = res.send.bind(res);

	res.send = (body) => {
		(async () => {
			const apexLocal = isApexLocals(res.locals.apex) ? res.locals.apex : undefined;
			if (apexLocal) {
				logger.info({
					type: 'response',
					status: res.statusCode,
					headers: res.getHeaders(),
					body,
					apex: summarizeApexLocals(apexLocal),
				});

				try {
					await runPostWork(res);
				} catch (err: unknown) {
					const error = toError(err);
					logger.error('post-response error:', error.message);
					logger.error(error);
				}
			}

			originalSend(body);
		})().catch((err: unknown) => {
			const error = toError(err);
			logger.error('response send error:', error.message);
			logger.error(error);
		});

		return res;
	};

	next();
};
