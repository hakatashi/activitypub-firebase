import assert from 'node:assert';
import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { isEqual } from 'lodash-es';
import { db, escapeFirestoreKey } from './firebase.js';
import { buildMetaIndex } from './meta.js';
import { Objects, UserInfos } from './schema.js';
import {
	isAPAnnounce,
	isAPLike,
	isAPNote,
	isAPTombstone,
	toIdArray,
	toTypeArray,
} from './utils.js';

export const onStreamWritten = onDocumentWritten('streams/{streamId}', async (event) => {
	const stream = event.data?.after?.data?.();
	// If stream is undefined, it means the document is deleted
	if (stream === undefined) {
		return;
	}
	assert(event.data?.after?.ref !== undefined);

	// `_meta.collection`(apex 所有の配列)と `actor`/`object` を、Firestore で絞り込める
	// map 形式のインデックスに非正規化する(→ ADR-0021)。actor/object は IRI 文字列・Link・
	// 埋め込みオブジェクトのいずれにもなりうるため、buildMetaIndex 内の toIdArray で
	// スカラー ID に正規化される。
	const newIndex = buildMetaIndex(stream);

	if (!isEqual(stream._meta?.index, newIndex)) {
		await event.data.after.ref.update({ '_meta.index': newIndex });
	}
});

export const onStreamCreated = onDocumentCreated('streams/{streamId}', async (event) => {
	const stream = event.data?.data?.();
	// If stream is undefined, it means the document is deleted
	if (stream === undefined) {
		return;
	}
	assert(event.data?.ref !== undefined);

	const objects = Array.isArray(stream.object)
		? stream.object
		: [stream.object].filter((object) => object !== undefined && object !== null);
	// actor/object は IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうるため、
	// escapeFirestoreKey に渡す前に toIdArray でスカラー ID に正規化する(→ ADR-0020)。
	const actorId = toIdArray(stream.actor)[0];

	// 更新計画を収集 (ID ごとのデルタ)
	const userInfoDeltas = new Map<string, { statusesDelta?: number }>();
	const objectDeltas = new Map<string, { likesDelta?: number; sharesDelta?: number }>();

	const getUserInfoDelta = (id: string) => {
		let delta = userInfoDeltas.get(id);
		if (!delta) {
			delta = {};
			userInfoDeltas.set(id, delta);
		}
		return delta;
	};

	const getObjectDelta = (id: string) => {
		let delta = objectDeltas.get(id);
		if (!delta) {
			delta = {};
			objectDeltas.set(id, delta);
		}
		return delta;
	};

	// Denormalize userInfos.statuses_count
	// stream.type が Create であることも確認する。apex 本体の activity.save は
	// Like/Announce にも解決済みの object を埋め込んで保存するため、embed された object の
	// 型だけで判定すると、投稿への Like/Announce のたびに「いいねした側」の
	// statuses_count を誤って増やそうとしてしまう (存在しない UserInfos への
	// update は例外になり、他の更新も巻き添えで失われる → ADR-0039)。
	// Delete の場合は statuses_count を減算する (→ ADR-0064)。
	const isCreate = toTypeArray(stream.type).includes('Create');
	const isDelete = toTypeArray(stream.type).includes('Delete');
	const isNote = isCreate && objects.some(isAPNote);
	const isDeletedNote =
		isDelete && objects.some((object) => isAPNote(object) || isAPTombstone(object));
	if (isNote && actorId !== undefined) {
		getUserInfoDelta(actorId).statusesDelta = 1;
	}
	if (isDeletedNote && actorId !== undefined) {
		getUserInfoDelta(actorId).statusesDelta = -1;
	}

	// Denormalize objects._meta.likesCount / sharesCount (→ ADR-0037)。apex 本体の
	// likes/shares コレクション機構は activity (streams) 専用で Note のような object を
	// 対象にすると壊れるため使わず、followers_count と同じ非正規化カウンタのパターンを
	// _meta に対して適用する。
	if (toTypeArray(stream.type).includes('Like')) {
		for (const objectId of toIdArray(stream.object)) {
			getObjectDelta(objectId).likesDelta = (getObjectDelta(objectId).likesDelta ?? 0) + 1;
		}
	}

	if (toTypeArray(stream.type).includes('Announce')) {
		for (const objectId of toIdArray(stream.object)) {
			getObjectDelta(objectId).sharesDelta = (getObjectDelta(objectId).sharesDelta ?? 0) + 1;
		}
	}

	if (toTypeArray(stream.type).includes('Undo')) {
		for (const object of objects) {
			if (isAPLike(object)) {
				for (const likedObjectId of toIdArray(object.object)) {
					getObjectDelta(likedObjectId).likesDelta =
						(getObjectDelta(likedObjectId).likesDelta ?? 0) - 1;
				}
			}
			if (isAPAnnounce(object)) {
				for (const sharedObjectId of toIdArray(object.object)) {
					getObjectDelta(sharedObjectId).sharesDelta =
						(getObjectDelta(sharedObjectId).sharesDelta ?? 0) - 1;
				}
			}
		}
	}

	if (userInfoDeltas.size === 0 && objectDeltas.size === 0) {
		return;
	}

	// トランザクションで安全にアトミック更新し、0 未満へのアンダーフローを防ぐ (→ ADR-0053)。
	// また対象ドキュメントが存在しない場合はスキップし、例外で処理が落ちないようにする (→ ADR-0039)。
	await db.runTransaction(async (transaction) => {
		const userInfoEntries = Array.from(userInfoDeltas.entries()).map(([id, delta]) => ({
			ref: UserInfos.doc(escapeFirestoreKey(id)),
			delta,
		}));
		const objectEntries = Array.from(objectDeltas.entries()).map(([id, delta]) => ({
			ref: Objects.doc(escapeFirestoreKey(id)),
			delta,
		}));

		const [userInfoEntriesWithDocs, objectEntriesWithDocs] = await Promise.all([
			Promise.all(
				userInfoEntries.map(async (entry) => ({
					...entry,
					doc: await transaction.get(entry.ref),
				})),
			),
			Promise.all(
				objectEntries.map(async (entry) => ({
					...entry,
					doc: await transaction.get(entry.ref),
				})),
			),
		]);

		userInfoEntriesWithDocs.forEach((entry) => {
			if (!entry.doc.exists) {
				return;
			}
			const data = entry.doc.data();
			assert(data !== undefined);
			const updates: Record<string, number> = {};
			if (entry.delta.statusesDelta !== undefined) {
				updates.statuses_count = Math.max(
					0,
					(data.statuses_count ?? 0) + entry.delta.statusesDelta,
				);
			}
			if (Object.keys(updates).length > 0) {
				transaction.update(entry.ref, updates);
			}
		});

		objectEntriesWithDocs.forEach((entry) => {
			if (!entry.doc.exists) {
				return;
			}
			const data = entry.doc.data();
			assert(data !== undefined);
			const updates: Record<string, number> = {};
			if (entry.delta.likesDelta !== undefined) {
				updates['_meta.likesCount'] = Math.max(
					0,
					(data._meta?.likesCount ?? 0) + entry.delta.likesDelta,
				);
			}
			if (entry.delta.sharesDelta !== undefined) {
				updates['_meta.sharesCount'] = Math.max(
					0,
					(data._meta?.sharesCount ?? 0) + entry.delta.sharesDelta,
				);
			}
			if (Object.keys(updates).length > 0) {
				transaction.update(entry.ref, updates);
			}
		});
	});
});
