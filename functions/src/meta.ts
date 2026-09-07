import firebase from 'firebase-admin';
import type { FirestoreKey } from './firebase.js';
import { escapeFirestoreKey } from './firebase.js';
import { toIdArray } from './utils.js';

// `streams` ドキュメントの `_meta.index` は、Firestore に絞り込ませるためだけに存在する
// 非正規化インデックス(→ ADR-0021)。IRI の集合を `{ エスケープした IRI: true }` の map として
// 持つことで、Firestore の「1クエリにつき array-contains は1つまで」という制約を受けずに
// 複数の条件を組み合わせられる。
//
// 取得済みのドキュメントに対する判定にはこのインデックスを使わず、生の `actor`/`object` を
// `toIdArray` で解決して使うこと(インデックスの書き込みは onStreamWritten トリガー経由で
// 遅延するため)。

export const META_INDEX_FIELDS = ['collections', 'actors', 'objects'] as const;

export type MetaIndexField = (typeof META_INDEX_FIELDS)[number];

export type IdIndex = Record<FirestoreKey, true>;

export type MetaIndex = Record<MetaIndexField, IdIndex>;

// `objects` / `streams` の `_meta` は apex 本体やこのプロジェクトの拡張が書き込むキーの集合で、
// AP オブジェクトと同様に厳密なスキーマ化はしない(→ ADR-0023 決定2)。既知のキーだけ型を与える。
export interface ObjectMeta {
	collection?: string[];
	privateKey?: string;
	index?: MetaIndex;
	[key: string]: unknown;
}

// IRI の集合を map 形式のインデックスに変換する。IRI はドットやスラッシュを含むため、
// ドキュメント ID と同じ escapeFirestoreKey でキーをエスケープする。
export const toIdIndex = (ids: Iterable<string>): IdIndex =>
	Object.fromEntries(Array.from(ids, (id) => [escapeFirestoreKey(id), true as const]));

// `_meta.index.<field>.<エスケープした IRI>` を指す FieldPath。IRI に含まれるドットが
// パス区切りと誤解釈されないよう、文字列連結ではなく必ず配列形式の FieldPath を使う。
export const metaIndexPath = (field: MetaIndexField, key: FirestoreKey) =>
	new firebase.firestore.FieldPath('_meta', 'index', field, key);

// stream ドキュメントの現在の内容から、あるべき `_meta.index` を計算する。
export const buildMetaIndex = (stream: {
	_meta?: { collection?: unknown } | undefined;
	actor?: unknown;
	object?: unknown;
	[key: string]: unknown;
}): MetaIndex => ({
	collections: toIdIndex(toIdArray(stream._meta?.collection)),
	actors: toIdIndex(toIdArray(stream.actor)),
	objects: toIdIndex(toIdArray(stream.object)),
});
