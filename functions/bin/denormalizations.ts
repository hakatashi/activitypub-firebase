import firebase from 'firebase-admin';
import { countBy, isEqual } from 'lodash-es';
import { db, toFirestoreKey, unescapeFirestoreKey } from '../src/firebase.js';
import { localFollowersId, localFollowingId } from '../src/localActor.js';
import { buildMetaIndex } from '../src/meta.js';
import { Streams, UserInfos } from '../src/schema.js';
import { isAPNote, toArray, toIdArray } from '../src/utils.js';

// 単一ユーザー運用 (AGENTS.md) の前提で決め打ち。ADR-0035 のバックフィル専用。
const followersId = localFollowersId;
const followingId = localFollowingId;

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
		streams.docs.filter((streamDoc) => toArray(streamDoc.data().object).some(isAPNote)),
		(streamDoc) => toIdArray(streamDoc.data().actor)[0],
	);

	// 同じ actor から同じ相手への Follow は 1 件だけ残す (→ ADR-0075)。
	// 残す Follow は、Undo されていないもの → followers コレクションに所属する (Accept 済みの)
	// もの → 新しいもの、の順で選ぶ。Undo 済みの古い Follow を残すと、実際にはフォロー中の
	// 相手がフォロワーから落ちてしまう。`published` は無い Follow が多いので頼りにしない。
	const undoneFollowIds = new Set(
		streams.docs
			.filter((streamDoc) => streamDoc.data().type === 'Undo')
			.flatMap((streamDoc) => toIdArray(streamDoc.data().object)),
	);
	const supersededFollowIds = new Set<string>();
	const followGroups = new Map<string, typeof streams.docs>();
	for (const streamDoc of streams.docs) {
		const stream = streamDoc.data();
		if (stream.type !== 'Follow') {
			continue;
		}
		const key = `${toIdArray(stream.actor)[0]} ${toIdArray(stream.object)[0]}`;
		followGroups.set(key, [...(followGroups.get(key) ?? []), streamDoc]);
	}
	const followRank = (streamDoc: (typeof streams.docs)[number]) => {
		const stream = streamDoc.data();
		return [
			undoneFollowIds.has(stream.id) ? 0 : 1,
			toIdArray(stream._meta?.collection).includes(followersId) ? 1 : 0,
			String(stream.published ?? ''),
		] as const;
	};
	for (const group of followGroups.values()) {
		const [keep] = [...group].toSorted((x, y) => {
			const [rx, ry] = [followRank(x), followRank(y)];
			return ry[0] - rx[0] || ry[1] - rx[1] || ry[2].localeCompare(rx[2]);
		});
		for (const streamDoc of group) {
			if (streamDoc !== keep) {
				supersededFollowIds.add(streamDoc.id);
			}
		}
	}
	console.log(`superseded follows: ${supersededFollowIds.size}`);

	streams.docs.forEach((streamDoc) => {
		const stream = streamDoc.data();

		if (supersededFollowIds.has(streamDoc.id)) {
			transaction.delete(streamDoc.ref);
			return;
		}

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
			if (key !== undefined && stream._meta?.[key] !== undefined) {
				updates[field] = firebase.firestore.FieldValue.delete();
			}
		}

		// Backfill _meta.isPublic: 承認済み (followers コレクション所属) の Follow は
		// isPublic() が true を返すようにする (→ ADR-0035)。この修正より前に承認された
		// Follow は _meta.isPublic を持たないため、匿名の /followers から漏れ続けていた。
		if (
			stream.type === 'Follow' &&
			toIdArray(stream._meta?.collection).includes(followersId) &&
			stream._meta?.isPublic !== true
		) {
			updates['_meta.isPublic'] = true;
		}

		// 自分発の Follow も同様に、following コレクション所属なら公開扱いにする。
		if (
			stream.type === 'Follow' &&
			toIdArray(stream._meta?.collection).includes(followingId) &&
			stream._meta?.isPublic !== true
		) {
			updates['_meta.isPublic'] = true;
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
	});
});
// followers_count / following_count は bin/backfillFollowProjection.ts が射影から書き直す (→ ADR-0082)。
