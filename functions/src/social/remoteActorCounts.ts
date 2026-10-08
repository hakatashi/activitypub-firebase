import { createHash } from 'node:crypto';
import { GrpcStatus } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey } from '../firebase.js';
import { Objects } from '../schema.js';
import { getNotes } from '../store/notes.js';
import { isAPActor, toArray, toIdArray } from '../utils.js';
import {
	getObjectOrUndefined,
	hostOf,
	isLocalHost,
	requestRemoteObject,
} from './remoteResolution.js';

// リモート actor の件数・最終投稿日を Cloud Tasks で取得し、actor の `_meta` に保存する (→ ADR-0104)。

// 保存した件数をこれより古いとみなして取り直す間隔。
export const REMOTE_ACTOR_COUNTS_TTL_MS = 24 * 60 * 60 * 1000;

export const REMOTE_ACTOR_REFRESH_QUEUE = 'remoteActorRefreshTask';

const remoteActorStatsSchema = z.object({
	followersCount: z.number().int().nonnegative().optional().catch(undefined),
	followingCount: z.number().int().nonnegative().optional().catch(undefined),
	statusesCount: z.number().int().nonnegative().optional().catch(undefined),
	lastStatusAt: z.string().optional().catch(undefined),
	countsFetchedAt: z.string().optional().catch(undefined),
});

export type RemoteActorStats = z.infer<typeof remoteActorStatsSchema>;

// actor の `_meta` から保存済みの件数を読む。壊れた値は無視する。
export const readRemoteActorStats = (meta: unknown): RemoteActorStats => {
	const parsed = remoteActorStatsSchema.safeParse(meta ?? {});
	return parsed.success ? parsed.data : {};
};

export const isRemoteActor = (actor: APObject) => {
	const host = typeof actor.id === 'string' ? hostOf(actor.id) : undefined;
	return host !== undefined && !isLocalHost(host);
};

export const isRemoteActorStatsStale = (stats: RemoteActorStats, now = Date.now()) => {
	if (stats.countsFetchedAt === undefined) {
		return true;
	}
	const fetchedAt = Date.parse(stats.countsFetchedAt);
	return Number.isNaN(fetchedAt) || now - fetchedAt >= REMOTE_ACTOR_COUNTS_TTL_MS;
};

// 同じ actor への依頼を 1 日 1 回にするためのタスク ID (Cloud Tasks の重複排除に使う)。
export const remoteActorRefreshTaskId = (actorIri: string, now: Date) => {
	const hash = createHash('sha256').update(actorIri).digest('hex').slice(0, 32);
	return `remote-actor-${hash}-${now.toISOString().slice(0, 10).replaceAll('-', '')}`;
};

// テストで差し替えられるよう、enqueue はオブジェクトのメソッドにしておく。
export const remoteActorRefreshQueue = {
	enqueue: async (actorIri: string, now = new Date()) => {
		await getFunctions()
			.taskQueue(REMOTE_ACTOR_REFRESH_QUEUE)
			.enqueue({ actorIri }, { id: remoteActorRefreshTaskId(actorIri, now) });
	},
};

// リモート actor の保存済みの件数が古ければ、取得をタスクに頼む。失敗しても呼び出し元には投げない。
// `actor` は `_meta` 付きで渡す。
export const requestRemoteActorRefreshIfStale = async (actor: APObject) => {
	if (!isRemoteActor(actor) || !isRemoteActorStatsStale(readRemoteActorStats(actor._meta))) {
		return;
	}
	const actorIri = String(actor.id);
	try {
		await remoteActorRefreshQueue.enqueue(actorIri);
	} catch (error) {
		const code =
			typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
		// 今日すでに頼んでいる。
		if (code === 'functions/task-already-exists') {
			return;
		}
		logger.warn({
			type: 'remoteActorRefreshEnqueueFailed',
			actorIri,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

const toTotalItems = (value: unknown): number | undefined => {
	const [first] = toArray(value);
	const count = typeof first === 'string' ? Number(first) : first;
	return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
};

// コレクションの `totalItems` を取得する。取れなければ undefined。
export const fetchCollectionTotalItems = async (
	collectionIri: string | undefined,
): Promise<number | undefined> => {
	if (collectionIri === undefined) {
		return undefined;
	}
	const collection = await requestRemoteObject(collectionIri);
	return collection === undefined ? undefined : toTotalItems(collection.totalItems);
};

// `published` の日付の部分 (YYYY-MM-DD)。
const toDateString = (value: unknown) => {
	const [first] = toArray(value);
	if (typeof first !== 'string') {
		return undefined;
	}
	const time = Date.parse(first);
	return Number.isNaN(time) ? undefined : new Date(time).toISOString().slice(0, 10);
};

// actor のコレクションの件数と手元の最新の Note の日付を取り直して `_meta` に保存する。
// 取れなかった件数は前回の値を残す (→ ADR-0104)。
export const refreshRemoteActorCounts = async (actorIri: string, now = new Date()) => {
	const actor = await getObjectOrUndefined(actorIri);
	if (actor === undefined || !isAPActor(actor) || !isRemoteActor(actor)) {
		logger.info({ type: 'remoteActorRefreshSkipped', actorIri });
		return;
	}

	const [followersCount, followingCount, statusesCount, latestNotes] = await Promise.all([
		fetchCollectionTotalItems(toIdArray(actor.followers)[0]),
		fetchCollectionTotalItems(toIdArray(actor.following)[0]),
		fetchCollectionTotalItems(toIdArray(actor.outbox)[0]),
		getNotes({ actors: [actorIri], limit: 1 }),
	]);
	const lastStatusAt = toDateString(latestNotes[0]?.published);

	const updates: Record<string, unknown> = {
		'_meta.countsFetchedAt': now.toISOString(),
		...(followersCount === undefined ? {} : { '_meta.followersCount': followersCount }),
		...(followingCount === undefined ? {} : { '_meta.followingCount': followingCount }),
		...(statusesCount === undefined ? {} : { '_meta.statusesCount': statusesCount }),
		...(lastStatusAt === undefined ? {} : { '_meta.lastStatusAt': lastStatusAt }),
	};
	try {
		await Objects.doc(escapeFirestoreKey(actorIri)).update(updates);
	} catch (error) {
		// 取得中に actor が消えた。
		if ((error as { code?: unknown }).code === GrpcStatus.NOT_FOUND) {
			return;
		}
		throw error;
	}
	logger.info({
		type: 'remoteActorRefreshed',
		actorIri,
		followersCount,
		followingCount,
		statusesCount,
		lastStatusAt,
	});
};
