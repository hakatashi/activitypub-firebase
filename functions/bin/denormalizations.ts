import firebase from 'firebase-admin';
import { countBy, isEqual } from 'lodash-es';
import { db, toFirestoreKey, unescapeFirestoreKey } from '../src/firebase.js';
import { buildMetaIndex } from '../src/meta.js';
import { Streams, UserInfos } from '../src/schema.js';
import { toIdArray } from '../src/utils.js';

// ADR-0021 より前のスキーマで書き込まれた非正規化フィールド。バックフィル時に削除する。
const LEGACY_META_FIELDS = [
	'_meta.actorIds',
	'_meta.objectIds',
	'_meta.objectType',
	'_meta.objectTypes',
];

db.runTransaction(async (transaction) => {
	const streams = await transaction.get(Streams);
	console.log(`streams: ${streams.docs.length}`);

	const userInfos = await transaction.get(UserInfos);
	console.log(`userInfos: ${userInfos.docs.length}`);

	// actor/object は IRI 文字列・Link・埋め込みオブジェクトのいずれにもなりうるため、
	// スカラー ID として集計できるよう toIdArray で正規化する(→ ADR-0020)。
	const statusCounts = countBy(
		streams.docs.filter((streamDoc) =>
			(streamDoc.data().object ?? []).some((object: any) => object.type === 'Note'),
		),
		(streamDoc) => toIdArray(streamDoc.data().actor)[0],
	);

	const follows = streams.docs
		.filter((streamDoc) => streamDoc.data().type === 'Follow')
		.flatMap((streamDoc) => toIdArray(streamDoc.data().object));
	const followCounts = countBy(follows);

	const unfollows = streams.docs
		.filter((streamDoc) => streamDoc.data().type === 'Undo')
		.flatMap((streamDoc) => streamDoc.data().object ?? [])
		.filter((object: any) => object.type === 'Follow')
		.flatMap((object: any) => toIdArray(object.object));
	const unfollowCounts = countBy(unfollows);

	streams.docs.forEach((streamDoc) => {
		const stream = streamDoc.data();

		const updates: Record<string, unknown> = {};

		// Backfill _meta.collection: スカラーで保存されている既存ドキュメントを配列化する (→ ADR-0017)
		if (typeof stream._meta?.collection === 'string') {
			updates['_meta.collection'] = [stream._meta.collection];
		}

		// Backfill _meta.index (→ ADR-0021)
		const newIndex = buildMetaIndex(stream);
		if (!isEqual(stream._meta?.index, newIndex)) {
			updates['_meta.index'] = newIndex;
		}

		// ADR-0021 で廃止した _meta.actorIds / objectIds / objectType / objectTypes を削除する
		for (const field of LEGACY_META_FIELDS) {
			const [, key] = field.split('.');
			if (stream._meta?.[key] !== undefined) {
				updates[field] = firebase.firestore.FieldValue.delete();
			}
		}

		if (Object.keys(updates).length > 0) {
			transaction.update(streamDoc.ref, updates);
		}
	});

	userInfos.docs.forEach((userInfoDoc) => {
		const userInfo = userInfoDoc.data();
		const actorId = unescapeFirestoreKey(toFirestoreKey(userInfoDoc.id));

		// Denormalize statuses_count
		const oldStatusCount = userInfo.statuses_count;
		const newStatusCount = statusCounts[actorId] ?? 0;
		if (oldStatusCount !== newStatusCount) {
			transaction.update(userInfoDoc.ref, {
				statuses_count: newStatusCount,
			});
		}

		// Denormalize followers_count
		const oldFollowersCount = userInfo.followers_count;
		const newFollowersCount = (followCounts[actorId] ?? 0) - (unfollowCounts[actorId] ?? 0);
		if (oldFollowersCount !== newFollowersCount) {
			transaction.update(userInfoDoc.ref, {
				followers_count: newFollowersCount,
			});
		}
	});
});
