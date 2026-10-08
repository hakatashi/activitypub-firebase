import { countBy } from 'lodash-es';
import { Objects } from '../src/schema.js';
import { getCountedReplyTarget } from '../src/store/replies.js';

// objects の `_meta.repliesCount` を、手元にある返信から数え直すバックフィル (→ ADR-0102)。
// 保存時と同じ規則 (getCountedReplyTarget) で数え、値が合っているものはスキップするので、
// 何度実行してもよい。`--dry-run` で書き込まずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const objects = await Objects.get();
const counts = countBy(
	objects.docs.flatMap((doc) => getCountedReplyTarget(doc.data()) ?? []),
	(target) => target,
);
let updated = 0;
for (const doc of objects.docs) {
	const data = doc.data();
	const expected = counts[data.id] ?? 0;
	if ((data._meta?.repliesCount ?? 0) === expected) {
		continue;
	}
	updated++;
	if (!dryRun) {
		await doc.ref.update({ '_meta.repliesCount': expected });
	}
}
console.log({ dryRun, objects: objects.docs.length, updated });
