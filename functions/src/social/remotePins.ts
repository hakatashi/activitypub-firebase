import firebase from 'firebase-admin';
import { GrpcStatus } from 'firebase-admin/firestore';
import { getFunctions } from 'firebase-admin/functions';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import { apex } from '../apex.js';
import type { APObject } from '../apex/index.js';
import { db, escapeFirestoreKey, taskQueueName } from '../firebase.js';
import { Objects, UserInfos } from '../schema.js';
import { getAttributedTo, isAPActor, isAPNote, objectToTypeArray, toIdArray } from '../utils.js';
import {
	REMOTE_ACTOR_COUNTS_TTL_MS,
	REMOTE_ACTOR_REFRESH_QUEUE,
	isRemoteActor,
	isTaskAlreadyExistsError,
	remoteActorRefreshTaskId,
} from './remoteActorCounts.js';
import type { Fetcher } from './remoteOutbox.js';
import {
	collectionItems,
	createFetcher,
	firstOfValue,
	isObject,
	resolvePage,
} from './remoteOutbox.js';
import { getObjectOrUndefined, originOf, requestRemoteObject } from './remoteResolution.js';

// リモート actor のピン留めを、`featured` コレクションと `Add` / `Remove` から取り込む (→ ADR-0141)。
// 保存先はローカルと同じ `userInfos/{actor}/pins/{noteKey}`。

// 1 actor あたりに保存するピン留めの上限。
export const REMOTE_PINS_MAX_ITEMS = 20;
// 1 回の同期で外部へ送るリクエストの上限 (`featured` 本体・ページ・IRI だけの Note の取得を含む)。
export const FEATURED_MAX_REQUESTS = 10;

// actor の `featured` コレクションの IRI。Mastodon の拡張なので、圧縮後は `toot:featured` になっていることが多い。
export const featuredCollectionOf = (actor: APObject) =>
	toIdArray(
		actor.featured ?? actor['toot:featured'] ?? actor['http://joinmastodon.org/ns#featured'],
	)[0];

const featuredFetchedAtSchema = z.object({
	featuredFetchedAt: z.string().optional().catch(undefined),
});

export const isRemoteFeaturedStale = (meta: unknown, now = Date.now()) => {
	const parsed = featuredFetchedAtSchema.safeParse(meta ?? {});
	const fetchedAt = parsed.success ? parsed.data.featuredFetchedAt : undefined;
	if (fetchedAt === undefined) {
		return true;
	}
	const time = Date.parse(fetchedAt);
	return Number.isNaN(time) || now - time >= REMOTE_ACTOR_COUNTS_TTL_MS;
};

// テストで差し替えられるよう、enqueue はオブジェクトのメソッドにしておく。
export const remoteFeaturedSyncQueue = {
	enqueue: async (actorIri: string, now = new Date()) => {
		await getFunctions()
			.taskQueue(taskQueueName(REMOTE_ACTOR_REFRESH_QUEUE))
			.enqueue(
				{ actorIri, kind: 'featured' },
				{ id: remoteActorRefreshTaskId(actorIri, now, 'featured') },
			);
	},
};

// リモート actor の `featured` を前回取得してから 24 時間以上経っていれば、同期をタスクに頼む。
// 失敗しても呼び出し元には投げない。`actor` は `_meta` 付きで渡す。
export const requestRemoteFeaturedSyncIfStale = async (actor: APObject) => {
	if (
		!isRemoteActor(actor) ||
		featuredCollectionOf(actor) === undefined ||
		!isRemoteFeaturedStale(actor._meta)
	) {
		return;
	}
	const actorIri = String(actor.id);
	try {
		await remoteFeaturedSyncQueue.enqueue(actorIri);
	} catch (error) {
		if (isTaskAlreadyExistsError(error)) {
			return;
		}
		logger.warn({
			type: 'remoteFeaturedSyncEnqueueFailed',
			actorIri,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

const pinsOf = (actorIri: string) => UserInfos.doc(escapeFirestoreKey(actorIri)).collection('pins');

// actor 自身の投稿で、actor と同じオリジンの Note か。
const isNoteOf = (
	note: APObject | undefined,
	actorIri: string,
): note is APObject & { id: string } =>
	isAPNote(note) &&
	typeof note.id === 'string' &&
	originOf(note.id) === originOf(actorIri) &&
	getAttributedTo(note) === actorIri;

// ピン留めする Note を手元から探し、なければ取得して保存する。actor の Note でなければ undefined。
// 手元にある Note は書き換えない (→ ADR-0140)。
const resolvePinnedNote = async (
	value: unknown,
	actorIri: string,
	fetch: (iri: string) => Promise<APObject | undefined>,
): Promise<string | undefined> => {
	const noteIri = toIdArray(value)[0];
	if (noteIri === undefined || originOf(noteIri) !== originOf(actorIri)) {
		return undefined;
	}
	const cached = await getObjectOrUndefined(noteIri);
	if (cached !== undefined) {
		return isNoteOf(cached, actorIri) ? noteIri : undefined;
	}
	// 埋め込みは、呼び出し元が actor と同じオリジンから取得したものだけを渡す。
	const note =
		isObject(value) && objectToTypeArray(value).length > 0 ? value : await fetch(noteIri);
	if (note?.id !== noteIri || !isNoteOf(note, actorIri)) {
		return undefined;
	}
	await apex.store.saveObject(note);
	return noteIri;
};

// inbox で受けた `Add` / `Remove` を処理する。`target` が送信者の `featured` で、object が送信者と同じオリジンのものだけを扱う。
export const handleRemotePinActivity = async (actor: APObject, activity: APObject) => {
	const types = objectToTypeArray(activity);
	const isAdd = types.includes('Add');
	if (!isAdd && !types.includes('Remove')) {
		return;
	}
	const actorIri = typeof actor.id === 'string' ? actor.id : undefined;
	const featured = featuredCollectionOf(actor);
	const target = toIdArray(activity.target)[0];
	if (actorIri === undefined || !isRemoteActor(actor) || featured === undefined) {
		return;
	}
	if (target !== featured) {
		return;
	}
	// 注目のハッシュタグ (`Hashtag`) は扱わない。
	const objectValue = firstOfValue(activity.object);
	if (isObject(objectValue) && objectToTypeArray(objectValue).includes('Hashtag')) {
		return;
	}
	const pins = pinsOf(actorIri);

	if (!isAdd) {
		const noteIri = toIdArray(objectValue)[0];
		if (noteIri === undefined || originOf(noteIri) !== originOf(actorIri)) {
			return;
		}
		await pins.doc(escapeFirestoreKey(noteIri)).delete();
		logger.info({ type: 'remotePinRemoved', actorIri, noteIri });
		return;
	}

	// 埋め込みの Note は送信者が作ったものなので信用せず、IRI から取り直す。
	const noteIri = await resolvePinnedNote(toIdArray(objectValue)[0], actorIri, requestRemoteObject);
	if (noteIri === undefined) {
		logger.info({ type: 'remotePinIgnored', actorIri, object: toIdArray(objectValue)[0] });
		return;
	}
	const noteKey = escapeFirestoreKey(noteIri);
	const pinsSnap = await pins.get();
	if (!pinsSnap.docs.some((doc) => doc.id === noteKey) && pinsSnap.size >= REMOTE_PINS_MAX_ITEMS) {
		logger.info({ type: 'remotePinIgnored', actorIri, noteIri, reason: 'too many pins' });
		return;
	}
	await pins
		.doc(noteKey)
		.set({ noteIri, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
	logger.info({ type: 'remotePinAdded', actorIri, noteIri });
};

const recordFeaturedFetchedAt = async (actorIri: string, now: Date) => {
	try {
		await Objects.doc(escapeFirestoreKey(actorIri)).update({
			'_meta.featuredFetchedAt': now.toISOString(),
		});
	} catch (error) {
		// 取得中に actor が消えた。
		if ((error as { code?: unknown }).code === GrpcStatus.NOT_FOUND) {
			return;
		}
		throw error;
	}
};

// `featured` 本体と最初の 1 ページから、ピン留めする Note の IRI を順に集める。取得できなければ undefined。
const fetchFeaturedNoteIris = async (
	featuredIri: string,
	actorIri: string,
	fetcher: Fetcher,
): Promise<string[] | undefined> => {
	const featured = await fetcher.fetch(featuredIri);
	if (featured === undefined) {
		return undefined;
	}
	const page =
		collectionItems(featured).length > 0
			? featured
			: await resolvePage(firstOfValue(featured.first), fetcher);
	// `first` が無い・空のコレクションはピン留めなし。`first` を取得できなかったときだけ失敗とする。
	if (page === undefined) {
		return featured.first === undefined ? [] : undefined;
	}
	const noteIris: string[] = [];
	for (const item of collectionItems(page)) {
		if (noteIris.length >= REMOTE_PINS_MAX_ITEMS) {
			break;
		}
		const noteIri = await resolvePinnedNote(item, actorIri, fetcher.fetch);
		if (noteIri !== undefined && !noteIris.includes(noteIri)) {
			noteIris.push(noteIri);
		}
	}
	return noteIris;
};

// タスクの本体。`featured` を取得できたときだけ、`pins` をその内容に置き換える。
// 取得できなくても `_meta.featuredFetchedAt` は更新し、再試行は翌日の閲覧に任せる。
export const syncRemoteFeatured = async (actorIri: string, now = new Date()) => {
	const actor = await getObjectOrUndefined(actorIri);
	if (
		actor === undefined ||
		typeof actor.id !== 'string' ||
		!isAPActor(actor) ||
		!isRemoteActor(actor)
	) {
		logger.info({ type: 'remoteFeaturedSyncSkipped', actorIri });
		return;
	}
	const actorOrigin = originOf(actorIri);
	const featuredIri = featuredCollectionOf(actor);
	if (actorOrigin === undefined || featuredIri === undefined) {
		await recordFeaturedFetchedAt(actorIri, now);
		logger.info({ type: 'remoteFeaturedSyncSkipped', actorIri, reason: 'no featured' });
		return;
	}

	const fetcher = createFetcher(actorOrigin, FEATURED_MAX_REQUESTS);
	const noteIris = await fetchFeaturedNoteIris(featuredIri, actorIri, fetcher);
	if (noteIris !== undefined) {
		const pins = pinsOf(actorIri);
		const existing = await pins.get();
		const keys = new Set<string>(noteIris.map(escapeFirestoreKey));
		const batch = db.batch();
		for (const doc of existing.docs) {
			if (!keys.has(doc.id)) {
				batch.delete(doc.ref);
			}
		}
		// コレクションの先頭ほど新しいピン留めとして並ぶよう、createdAt を 1 ミリ秒ずつずらす。
		for (const [index, noteIri] of noteIris.entries()) {
			batch.set(pins.doc(escapeFirestoreKey(noteIri)), {
				noteIri,
				createdAt: firebase.firestore.Timestamp.fromMillis(now.getTime() - index),
			});
		}
		await batch.commit();
	}

	await recordFeaturedFetchedAt(actorIri, now);
	logger.info({
		type: noteIris === undefined ? 'remoteFeaturedSyncFailed' : 'remoteFeaturedSynced',
		actorIri,
		pins: noteIris?.length,
		requests: fetcher.requests,
	});
};
