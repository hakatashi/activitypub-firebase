import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { uniq } from 'lodash-es';
import type { APObject } from '../apex/index.js';
import { getObjects } from '../store/objects.js';
import { isAPActor, toIdArray } from '../utils.js';
import {
	REMOTE_ACTOR_REFRESH_QUEUE,
	isTaskAlreadyExistsError,
	remoteActorRefreshTaskId,
} from './remoteActorCounts.js';
import {
	getObjectOrUndefined,
	hostOf,
	isLocalHost,
	resolveRemoteActor,
} from './remoteResolution.js';

// 手元にないリモート actor を Cloud Tasks で取得して保存する (→ ADR-0106)。

// 1 リクエストで頼む actor の上限。
export const MAX_RESOLUTION_REQUESTS_PER_CALL = 10;

// このインスタンスで頼んだタスク ID。Cloud Tasks への重複した依頼を減らすだけなので、消えても困らない。
const requestedTaskIds = new Set<string>();
const MAX_REQUESTED_TASK_IDS = 10_000;

export const clearRequestedRemoteActorResolutions = () => {
	requestedTaskIds.clear();
};

// テストで差し替えられるよう、enqueue はオブジェクトのメソッドにしておく。
export const remoteActorResolutionQueue = {
	enqueue: async (actorIri: string, taskId: string) => {
		await getFunctions()
			.taskQueue(REMOTE_ACTOR_REFRESH_QUEUE)
			.enqueue({ actorIri, kind: 'resolve' }, { id: taskId });
	},
};

const isRemoteIri = (iri: string) => {
	const host = hostOf(iri);
	return host !== undefined && !isLocalHost(host);
};

// 手元にないと分かっている actor の取得をタスクに頼む。失敗しても呼び出し元には投げない。
export const requestRemoteActorResolution = async (actorIris: string[], now = new Date()) => {
	const targets = uniq(actorIris)
		.filter(isRemoteIri)
		.map((actorIri) => ({ actorIri, taskId: remoteActorRefreshTaskId(actorIri, now, 'resolve') }))
		.filter(({ taskId }) => !requestedTaskIds.has(taskId))
		.slice(0, MAX_RESOLUTION_REQUESTS_PER_CALL);
	if (targets.length === 0) {
		return;
	}
	if (requestedTaskIds.size + targets.length > MAX_REQUESTED_TASK_IDS) {
		requestedTaskIds.clear();
	}
	await Promise.all(
		targets.map(async ({ actorIri, taskId }) => {
			try {
				await remoteActorResolutionQueue.enqueue(actorIri, taskId);
				requestedTaskIds.add(taskId);
			} catch (error) {
				if (isTaskAlreadyExistsError(error)) {
					requestedTaskIds.add(taskId);
					return;
				}
				logger.warn({
					type: 'remoteActorResolutionEnqueueFailed',
					actorIri,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}),
	);
};

// actor IRI のうち `objects` にないものの取得をタスクに頼む。
export const requestResolutionOfUncachedActors = async (actorIris: string[]) => {
	const remoteIris = uniq(actorIris).filter(isRemoteIri);
	if (remoteIris.length === 0) {
		return;
	}
	const cached = new Set((await getObjects(remoteIris)).map((object) => String(object.id)));
	await requestRemoteActorResolution(remoteIris.filter((iri) => !cached.has(iri)));
};

// inbox で受け取った Create / Announce のオブジェクトの作者と、手元にあるリプライ先の作者を
// 手元になければ取得させる (→ ADR-0106)。失敗しても呼び出し元には投げない。
export const requestResolutionOfObjectActors = async (object: APObject | undefined) => {
	if (object === undefined || isAPActor(object)) {
		return;
	}
	try {
		const inReplyToIri = toIdArray(object.inReplyTo)[0];
		const inReplyTo =
			inReplyToIri === undefined ? undefined : await getObjectOrUndefined(inReplyToIri);
		await requestResolutionOfUncachedActors([
			...toIdArray(object.attributedTo),
			...toIdArray(inReplyTo?.attributedTo),
		]);
	} catch (error) {
		logger.warn({
			type: 'requestResolutionOfObjectActorsFailed',
			objectId: object.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

// タスクの本体。すでに手元にあれば何もしない。
export const resolveMissingRemoteActor = async (actorIri: string) => {
	if (!isRemoteIri(actorIri)) {
		logger.info({ type: 'remoteActorResolutionSkipped', actorIri });
		return;
	}
	if ((await getObjectOrUndefined(actorIri)) !== undefined) {
		logger.info({ type: 'remoteActorResolutionSkipped', actorIri, reason: 'cached' });
		return;
	}
	const actor = await resolveRemoteActor(actorIri);
	logger.info({
		type: actor === undefined ? 'remoteActorResolutionFailed' : 'remoteActorResolved',
		actorIri,
	});
};
