import firebase from 'firebase-admin';
import { isEqual, pick } from 'lodash-es';
import { toPublishedSortKey } from '../src/mastodonId.js';
import { ACTIVITY_QUERY_META_KEYS, buildActivityQueryMeta } from '../src/meta.js';
import { Streams } from '../src/schema.js';
import { isAPAnnounce } from '../src/utils.js';

// streams に検索用の `_meta.actor` / `_meta.published` を入れるバックフィル (→ ADR-0096)。
// タイムライン検索の対象となる Announce アクティビティのみに付与する。
// 保存時と同じ規則 (buildActivityQueryMeta) で計算し、値が合っているものはスキップするので、
// 何度実行してもよい。`--dry-run` で書き込まずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const streams = await Streams.get();
let updated = 0;
for (const doc of streams.docs) {
	const data = doc.data();
	const isAnnounce = isAPAnnounce(data);
	const expectedPublished = isAnnounce ? toPublishedSortKey(data.published) : undefined;
	const expectedQueryMeta = buildActivityQueryMeta(data);

	const currentPublished = data._meta?.published;
	const needsPublishedUpdate = expectedPublished !== currentPublished;
	const needsQueryMetaUpdate = !isEqual(
		pick(data._meta ?? {}, ACTIVITY_QUERY_META_KEYS),
		expectedQueryMeta,
	);

	if (!needsPublishedUpdate && !needsQueryMetaUpdate) {
		continue;
	}

	updated++;
	if (!dryRun) {
		const updates: Record<string, unknown> = {};
		if (needsPublishedUpdate) {
			updates['_meta.published'] = expectedPublished ?? firebase.firestore.FieldValue.delete();
		}
		if (needsQueryMetaUpdate) {
			for (const key of ACTIVITY_QUERY_META_KEYS) {
				updates[`_meta.${key}`] = expectedQueryMeta[key] ?? firebase.firestore.FieldValue.delete();
			}
		}
		await doc.ref.update(updates);
	}
}

console.log({ dryRun, streams: streams.docs.length, updated });
