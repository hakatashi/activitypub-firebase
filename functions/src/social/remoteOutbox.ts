import { GrpcStatus } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import { apex } from '../apex.js';
import type { APObject } from '../apex/index.js';
import { noteToVisibility } from '../addressing.js';
import { escapeFirestoreKey, taskQueueName } from '../firebase.js';
import { Objects } from '../schema.js';
import {
	getAttributedTo,
	isAPActor,
	isAPNote,
	objectToTypeArray,
	toArray,
	toIdArray,
} from '../utils.js';
import {
	REMOTE_ACTOR_COUNTS_TTL_MS,
	REMOTE_ACTOR_REFRESH_QUEUE,
	isRemoteActor,
	isTaskAlreadyExistsError,
	remoteActorRefreshTaskId,
} from './remoteActorCounts.js';
import { getObjectOrUndefined, originOf, requestRemoteObject } from './remoteResolution.js';

// リモート actor の過去の公開投稿を、プロフィール閲覧時に outbox から補完する (→ ADR-0140)。

// 辿る outbox のページ数と、取り込みを試みるアイテム数の上限。
export const OUTBOX_MAX_PAGES = 2;
export const OUTBOX_MAX_ITEMS = 40;
// 1 回のタスクで外部へ送るリクエストの上限 (outbox 本体・ページ・IRI だけのオブジェクトの取得を含む)。
export const OUTBOX_MAX_REQUESTS = 10;

const outboxFetchedAtSchema = z.object({
	outboxFetchedAt: z.string().optional().catch(undefined),
});

export const isRemoteOutboxStale = (meta: unknown, now = Date.now()) => {
	const parsed = outboxFetchedAtSchema.safeParse(meta ?? {});
	const fetchedAt = parsed.success ? parsed.data.outboxFetchedAt : undefined;
	if (fetchedAt === undefined) {
		return true;
	}
	const time = Date.parse(fetchedAt);
	return Number.isNaN(time) || now - time >= REMOTE_ACTOR_COUNTS_TTL_MS;
};

// テストで差し替えられるよう、enqueue はオブジェクトのメソッドにしておく。
export const remoteOutboxBackfillQueue = {
	enqueue: async (actorIri: string, now = new Date()) => {
		await getFunctions()
			.taskQueue(taskQueueName(REMOTE_ACTOR_REFRESH_QUEUE))
			.enqueue(
				{ actorIri, kind: 'outbox' },
				{ id: remoteActorRefreshTaskId(actorIri, now, 'outbox') },
			);
	},
};

// リモート actor の outbox を前回取得してから 24 時間以上経っていれば、補完をタスクに頼む。
// 失敗しても呼び出し元には投げない。`actor` は `_meta` 付きで渡す。
export const requestRemoteOutboxBackfillIfStale = async (actor: APObject) => {
	if (!isRemoteActor(actor) || !isRemoteOutboxStale(actor._meta)) {
		return;
	}
	const actorIri = String(actor.id);
	try {
		await remoteOutboxBackfillQueue.enqueue(actorIri);
	} catch (error) {
		if (isTaskAlreadyExistsError(error)) {
			return;
		}
		logger.warn({
			type: 'remoteOutboxBackfillEnqueueFailed',
			actorIri,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

const isObject = (value: unknown): value is APObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const firstOfValue = (value: unknown) => toArray(value)[0];

const collectionItems = (collection: APObject): unknown[] =>
	toArray(collection.orderedItems ?? collection.items);

// 外部へのリクエストの回数を数えながら、actor と同じオリジンのものだけを取得する。
const createFetcher = (actorOrigin: string) => {
	let requests = 0;
	return {
		get exhausted() {
			return requests >= OUTBOX_MAX_REQUESTS;
		},
		get requests() {
			return requests;
		},
		fetch: (url: string): Promise<APObject | undefined> => {
			if (requests >= OUTBOX_MAX_REQUESTS || originOf(url) !== actorOrigin) {
				return Promise.resolve(undefined);
			}
			requests++;
			return requestRemoteObject(url);
		},
	};
};

type Fetcher = ReturnType<typeof createFetcher>;

// 埋め込みか IRI のコレクションページを解決する。
const resolvePage = (value: unknown, fetcher: Fetcher): Promise<APObject | undefined> => {
	// 埋め込みでも `id` だけの参照なら取得する。
	if (isObject(value) && (value.orderedItems !== undefined || value.items !== undefined)) {
		return Promise.resolve(value);
	}
	const id = toIdArray(value)[0];
	return id === undefined ? Promise.resolve(undefined) : fetcher.fetch(id);
};

// outbox のアイテム (Create) から、取り込んでよい Note を取り出す。取り込めなければ undefined。
const noteFromItem = async (
	item: unknown,
	actor: APObject & { id: string },
	fetcher: Fetcher,
): Promise<APObject | undefined> => {
	if (!isObject(item) || !objectToTypeArray(item).includes('Create')) {
		return undefined;
	}
	if (toIdArray(item.actor)[0] !== actor.id) {
		return undefined;
	}
	const objectValue = firstOfValue(item.object);
	let note: APObject | undefined;
	if (isObject(objectValue) && objectToTypeArray(objectValue).length > 0) {
		note = objectValue;
	} else {
		const objectIri = toIdArray(objectValue)[0];
		if (objectIri === undefined || (await getObjectOrUndefined(objectIri)) !== undefined) {
			return undefined;
		}
		note = await fetcher.fetch(objectIri);
		if (note?.id !== objectIri) {
			return undefined;
		}
	}
	if (
		!isAPNote(note) ||
		typeof note.id !== 'string' ||
		originOf(note.id) !== originOf(actor.id) ||
		getAttributedTo(note) !== actor.id
	) {
		return undefined;
	}
	const visibility = noteToVisibility(note, toIdArray(actor.followers)[0]);
	return visibility === 'public' || visibility === 'unlisted' ? note : undefined;
};

const recordOutboxFetchedAt = async (actorIri: string, now: Date) => {
	try {
		await Objects.doc(escapeFirestoreKey(actorIri)).update({
			'_meta.outboxFetchedAt': now.toISOString(),
		});
	} catch (error) {
		// 取得中に actor が消えた。
		if ((error as { code?: unknown }).code === GrpcStatus.NOT_FOUND) {
			return;
		}
		throw error;
	}
};

// タスクの本体。outbox の先頭から最大 OUTBOX_MAX_PAGES ページを辿り、手元にない公開・非収載の Note を保存する。
// 手元にある Note は書き換えない。取得できなくても `_meta.outboxFetchedAt` は更新し、再試行は翌日の閲覧に任せる。
export const backfillRemoteOutbox = async (actorIri: string, now = new Date()) => {
	const actor = await getObjectOrUndefined(actorIri);
	if (
		actor === undefined ||
		typeof actor.id !== 'string' ||
		!isAPActor(actor) ||
		!isRemoteActor(actor)
	) {
		logger.info({ type: 'remoteOutboxBackfillSkipped', actorIri });
		return;
	}
	const actorWithId = actor as APObject & { id: string };
	const actorOrigin = originOf(actorIri);
	const outboxIri = toIdArray(actor.outbox)[0];
	if (actorOrigin === undefined || outboxIri === undefined) {
		await recordOutboxFetchedAt(actorIri, now);
		logger.info({ type: 'remoteOutboxBackfillSkipped', actorIri, reason: 'no outbox' });
		return;
	}

	const fetcher = createFetcher(actorOrigin);
	let saved = 0;
	let examined = 0;
	const outbox = await fetcher.fetch(outboxIri);
	let page: APObject | undefined;
	if (outbox !== undefined) {
		page =
			collectionItems(outbox).length > 0
				? outbox
				: await resolvePage(firstOfValue(outbox.first), fetcher);
	}

	for (let pageCount = 0; page !== undefined && pageCount < OUTBOX_MAX_PAGES; pageCount++) {
		for (const item of collectionItems(page)) {
			if (examined >= OUTBOX_MAX_ITEMS) {
				break;
			}
			examined++;
			const note = await noteFromItem(item, actorWithId, fetcher);
			if (note === undefined || (await getObjectOrUndefined(String(note.id))) !== undefined) {
				continue;
			}
			await apex.store.saveObject(note);
			saved++;
		}
		if (examined >= OUTBOX_MAX_ITEMS || pageCount + 1 >= OUTBOX_MAX_PAGES || fetcher.exhausted) {
			break;
		}
		const next = firstOfValue(page.next);
		page = next === undefined ? undefined : await resolvePage(next, fetcher);
	}

	await recordOutboxFetchedAt(actorIri, now);
	logger.info({
		type: outbox === undefined ? 'remoteOutboxBackfillFailed' : 'remoteOutboxBackfilled',
		actorIri,
		examined,
		saved,
		requests: fetcher.requests,
	});
};
