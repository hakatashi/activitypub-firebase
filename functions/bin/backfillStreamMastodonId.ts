import { db, toFirestoreKey, unescapeFirestoreKey } from '../src/firebase.js';
import { findMastodonIds, getMastodonIds } from '../src/mastodonId.js';
import { Streams } from '../src/schema.js';

// streams にコレクションの並べ替えキー `_meta.mastodonId` を入れるバックフィル (→ ADR-0146)。
// アクティビティの IRI の Mastodon ID を使う。未採番のものは保存時と同じく `published` を基準に採番する。
// 値が合っているものはスキップするので、何度実行してもよい。`--dry-run` で採番も書き込みもせずに件数だけ出す。

const dryRun = process.argv.includes('--dry-run');

const streams = await Streams.get();
// IRI はドキュメント ID から復元する (本文の `id` が欠けたドキュメントにも振れるように)。
const entries = streams.docs.map((doc) => ({
	doc,
	iri: unescapeFirestoreKey(toFirestoreKey(doc.id)),
	published: doc.get('published'),
}));

const ids = dryRun
	? await findMastodonIds(entries.map(({ iri }) => iri))
	: await getMastodonIds(entries.map(({ iri, published }) => ({ iri, published })));

// 件数が多い (dev で 1 万件以上) ので BulkWriter で並列に書く。
const writer = db.bulkWriter();
const writes: Promise<unknown>[] = [];
let updated = 0;
let unassigned = 0;
for (const { doc, iri } of entries) {
	const mastodonId = ids.get(iri);
	if (mastodonId === undefined) {
		unassigned++;
		continue;
	}
	if (doc.get('_meta.mastodonId') === mastodonId) {
		continue;
	}
	updated++;
	if (!dryRun) {
		writes.push(writer.update(doc.ref, { '_meta.mastodonId': mastodonId }));
	}
}

await writer.close();
await Promise.all(writes);
console.log({ dryRun, streams: streams.docs.length, updated, unassigned });
