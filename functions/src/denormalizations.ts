import assert from 'node:assert';
import firebase from 'firebase-admin';
import { onDocumentWritten, onDocumentCreated } from 'firebase-functions/v2/firestore';
import { isEqual } from 'lodash-es';
import { db, escapeFirestoreKey } from './firebase.js';
import { buildMetaIndex } from './meta.js';
import { Objects, UserInfos } from './schema.js';
import { isAPAnnounce, isAPFollow, isAPLike, isAPNote, toIdArray, toTypeArray } from './utils.js';

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

	if (isEqual(stream._meta?.index, newIndex)) {
		return;
	}

	await event.data.after.ref.update({ '_meta.index': newIndex });
});

export const onStreamCreated = onDocumentCreated('streams/{streamId}', async (event) => {
	const stream = event.data?.data?.();
	// If stream is undefined, it means the document is deleted
	if (stream === undefined) {
		return;
	}
	assert(event.data?.ref !== undefined);

	const batch = db.batch();

	const objects = Array.isArray(stream.object)
		? stream.object
		: [stream.object].filter((object) => object !== undefined && object !== null);
	// actor/object は IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうるため、
	// escapeFirestoreKey に渡す前に toIdArray でスカラー ID に正規化する(→ ADR-0020)。
	const actorId = toIdArray(stream.actor)[0];

	// Denormalize userInfos.statuses_count
	// stream.type が Create であることも確認する。apex 本体の activity.save は
	// Like/Announce にも解決済みの object を埋め込んで保存するため、embed された object の
	// 型だけで判定すると、投稿への Like/Announce のたびに「いいねした側」の
	// statuses_count を誤って増やそうとしてしまう (存在しない UserInfos への
	// batch.update() は例外になり、同じ batch の他の更新も巻き添えで失われる → ADR-0039)。
	const isCreate = toTypeArray(stream.type).includes('Create');
	const isNote = isCreate && objects.some(isAPNote);
	if (isNote && actorId !== undefined) {
		batch.update(UserInfos.doc(escapeFirestoreKey(actorId)), {
			statuses_count: firebase.firestore.FieldValue.increment(1),
		});
	}

	// Denormalize userInfos.followers_count
	if (toTypeArray(stream.type).includes('Follow')) {
		for (const objectId of toIdArray(stream.object)) {
			batch.update(UserInfos.doc(escapeFirestoreKey(objectId)), {
				followers_count: firebase.firestore.FieldValue.increment(1),
			});
		}
	}

	// Denormalize objects._meta.likesCount / sharesCount (→ ADR-0037)。apex 本体の
	// likes/shares コレクション機構は activity (streams) 専用で Note のような object を
	// 対象にすると壊れるため使わず、followers_count と同じ非正規化カウンタのパターンを
	// _meta に対して適用する。
	if (toTypeArray(stream.type).includes('Like')) {
		for (const objectId of toIdArray(stream.object)) {
			batch.update(Objects.doc(escapeFirestoreKey(objectId)), {
				'_meta.likesCount': firebase.firestore.FieldValue.increment(1),
			});
		}
	}

	if (toTypeArray(stream.type).includes('Announce')) {
		for (const objectId of toIdArray(stream.object)) {
			batch.update(Objects.doc(escapeFirestoreKey(objectId)), {
				'_meta.sharesCount': firebase.firestore.FieldValue.increment(1),
			});
		}
	}

	if (toTypeArray(stream.type).includes('Undo')) {
		for (const object of objects) {
			if (isAPFollow(object)) {
				for (const followObjectId of toIdArray(object.object)) {
					batch.update(UserInfos.doc(escapeFirestoreKey(followObjectId)), {
						followers_count: firebase.firestore.FieldValue.increment(-1),
					});
				}
			}
			if (isAPLike(object)) {
				for (const likedObjectId of toIdArray(object.object)) {
					batch.update(Objects.doc(escapeFirestoreKey(likedObjectId)), {
						'_meta.likesCount': firebase.firestore.FieldValue.increment(-1),
					});
				}
			}
			if (isAPAnnounce(object)) {
				for (const sharedObjectId of toIdArray(object.object)) {
					batch.update(Objects.doc(escapeFirestoreKey(sharedObjectId)), {
						'_meta.sharesCount': firebase.firestore.FieldValue.increment(-1),
					});
				}
			}
		}
	}

	await batch.commit();
});
