import firebase from 'firebase-admin';
import { toPublishedSortKey } from '../src/mastodonId.js';
import { Streams } from '../src/schema.js';
import { isAPAnnounce, toIdArray } from '../src/utils.js';

// streams に検索用の `_meta.actor` / `_meta.published` を入れるバックフィル (→ ADR-0096)。
// タイムライン検索の対象となる Announce アクティビティのみに付与する。
// 保存時と同じ規則で計算し、値が合っているものはスキップするので、何度実行してもよい。
// `--dry-run` で書き込まずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const streams = await Streams.get();
let updated = 0;
for (const doc of streams.docs) {
	const data = doc.data();
	const isAnnounce = isAPAnnounce(data);
	const expectedActor = isAnnounce ? toIdArray(data.actor)[0] : undefined;
	const expectedPublished = isAnnounce ? toPublishedSortKey(data.published) : undefined;

	const currentActor = data._meta?.actor;
	const currentPublished = data._meta?.published;

	const needsActorUpdate = expectedActor !== currentActor;
	const needsPublishedUpdate = expectedPublished !== currentPublished;

	if (!needsActorUpdate && !needsPublishedUpdate) {
		continue;
	}

	updated++;
	if (!dryRun) {
		const updates: Record<string, unknown> = {};
		if (needsActorUpdate) {
			updates['_meta.actor'] = expectedActor ?? firebase.firestore.FieldValue.delete();
		}
		if (needsPublishedUpdate) {
			updates['_meta.published'] = expectedPublished ?? firebase.firestore.FieldValue.delete();
		}
		await doc.ref.update(updates);
	}
}

console.log({ dryRun, streams: streams.docs.length, updated });
