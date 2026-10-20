import { chunk } from 'lodash-es';
import { Streams } from '../src/schema.js';

// streams の `actor` が文字列のアクティビティを配列に直すバックフィル (→ ADR-0131)。
// 投稿履歴のインポート (#323) が文字列のまま保存したため、`where('actor', 'array-contains', ...)` から漏れていた。
// 配列のものはスキップするので、何度実行してもよい。`--dry-run` で書き込まずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const streams = await Streams.get();
const targets = streams.docs.filter((doc) => typeof doc.get('actor') === 'string');
if (!dryRun) {
	for (const docs of chunk(targets, 400)) {
		const batch = Streams.firestore.batch();
		for (const doc of docs) {
			batch.update(doc.ref, { actor: [doc.get('actor')] });
		}
		await batch.commit();
	}
}
console.log({ dryRun, streams: streams.docs.length, updated: targets.length });
