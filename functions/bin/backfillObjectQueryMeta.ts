import firebase from 'firebase-admin';
import { isEqual, pick } from 'lodash-es';
import { OBJECT_QUERY_META_KEYS, buildObjectQueryMeta } from '../src/meta.js';
import { Objects } from '../src/schema.js';

// objects に検索用の `_meta.attributedTo` / `inReplyTo` / `preferredUsername` を入れるバックフィル
// (→ ADR-0086)。保存時と同じ規則 (buildObjectQueryMeta) で計算し、値が合っているものはスキップする
// ので、何度実行してもよい。`--dry-run` で書き込まずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const objects = await Objects.get();
let updated = 0;
for (const doc of objects.docs) {
	const data = doc.data();
	const expected = buildObjectQueryMeta(data);
	if (isEqual(pick(data._meta ?? {}, OBJECT_QUERY_META_KEYS), expected)) {
		continue;
	}
	updated++;
	if (!dryRun) {
		await doc.ref.update(
			Object.fromEntries(
				OBJECT_QUERY_META_KEYS.map((key) => [
					`_meta.${key}`,
					expected[key] ?? firebase.firestore.FieldValue.delete(),
				]),
			),
		);
	}
}
console.log({ dryRun, objects: objects.docs.length, updated });
