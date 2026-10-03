import { unescapeFirestoreKey, toFirestoreKey } from '../src/firebase.js';
import { getMastodonIds, toIdTimestamp } from '../src/mastodonId.js';
import { getMentionIris } from '../src/mastodon/statusAttributes.js';
import { Objects, Streams } from '../src/schema.js';
import { isAPNote } from '../src/utils.js';

// 既存の objects / streams に Mastodon ID を振るバックフィル (→ ADR-0006、ADR-0058、ADR-0069)。
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

// Note の Mention タグの href に含まれる actor IRI も集める (ADR-0069)。
const mentionIris = objects.docs.flatMap((doc) => {
	const data = doc.data();
	return isAPNote(data) ? getMentionIris(data) : [];
});

const mentionEntries = Array.from(new Set(mentionIris)).map((iri) => ({
	iri,
	published: undefined,
}));

const ids = await getMastodonIds([...entries, ...mentionEntries]);
console.log(`assigned or found: ${ids.size}`);
