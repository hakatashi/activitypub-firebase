import { toPublishedSortKey } from '../src/mastodonId.js';
import { Objects } from '../src/schema.js';

// objects に `_meta.published` (タイムラインの並べ替えキー) を入れるバックフィル (→ ADR-0062)。
// `published` は配列・表記揺れがありうるため、保存時と同じ規則 (toPublishedSortKey) で計算する。
// 値が合っているものはスキップするので、何度実行してもよい。`--dry-run` で書き込まずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const objects = await Objects.get();
let updated = 0;
for (const doc of objects.docs) {
	const key = toPublishedSortKey(doc.get('published'));
	if (key !== undefined && doc.get('_meta.published') !== key) {
		if (!dryRun) {
			await doc.ref.update({ '_meta.published': key });
		}
		updated++;
	}
}
console.log({ dryRun, objects: objects.docs.length, updated });
