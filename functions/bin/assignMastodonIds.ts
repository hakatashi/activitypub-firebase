import { unescapeFirestoreKey, toFirestoreKey } from '../src/firebase.js';
import { getMastodonIds, toIdTimestamp } from '../src/mastodonId.js';
import { Objects, Streams } from '../src/schema.js';

// 既存の objects / streams に Mastodon ID を振るバックフィル (→ ADR-0006、ADR-0058)。
// 新規保存時と同じく `published` を基準に採番するので、既存データの時系列順序が保たれる。
// 採番済みの IRI はスキップするため、何度実行してもよい。

const now = Date.now();

const [objects, streams] = await Promise.all([Objects.get(), Streams.get()]);
console.log(`objects: ${objects.docs.length}, streams: ${streams.docs.length}`);

// IRI はドキュメント ID から復元する (本文の `id` が欠けたドキュメントにも振れるように)。
const entries = [...objects.docs, ...streams.docs]
	.map((doc) => ({
		iri: unescapeFirestoreKey(toFirestoreKey(doc.id)),
		published: doc.get('published'),
	}))
	// 同一ミリ秒内のシーケンスが published の順に振られるよう、古い順に処理する。
	.sort((a, b) => toIdTimestamp(a.published, now) - toIdTimestamp(b.published, now));

const ids = await getMastodonIds(entries);
console.log(`assigned or found: ${ids.size}`);
