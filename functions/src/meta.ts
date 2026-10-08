import firebase from 'firebase-admin';
import type { FirestoreKey } from './firebase.js';
import { escapeFirestoreKey } from './firebase.js';
import { getObjectHashtags } from './hashtags.js';
import { isAPAnnounce, toIdArray, toStringValue } from './utils.js';

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
// AP オブジェクトと同様に厳密なスキーマ化はしない(→ ADR-0023 決定2)。apex が読み書きするキー
// (collection / privateKey / isPublic) は apex 側で型が付いており、このプロジェクト固有のキーだけを
// module augmentation で足す (→ ADR-0051)。
declare module './apex/types.js' {
	interface ObjectMeta {
		index?: MetaIndex;
		// objects コレクションのみで使う非正規化カウンタ (→ ADR-0037)。
		likesCount?: number;
		sharesCount?: number;
		// objects コレクションのみで使う返信数の非正規化カウンタ (→ ADR-0102)。
		repliesCount?: number;
		// タイムラインの並べ替え・範囲指定用の published (→ ADR-0062, ADR-0096)。objects / streams コレクション。
		published?: string;
		// objects の検索用に、配列にもスカラーにもなりうるフィールドを正規化した写し (→ ADR-0086)。
		attributedTo?: string;
		inReplyTo?: string;
		preferredUsername?: string;
		// objects のタグ検索用に、`tag` の Hashtag の名前を正規化した写し (→ ADR-0103)。
		hashtags?: string[];
		// streams の検索用に、配列にもスカラーにもなりうる actor を正規化した写し (→ ADR-0096)。
		actor?: string;
	}
}

export type { ObjectMeta } from './apex/index.js';

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

// `objects` ドキュメントの `_meta` に非正規化する検索用フィールド (→ ADR-0086)。apex が受信した
// オブジェクトは `compactArrays: false` で配列になり、ローカルで作ったものはスカラーのままなので、
// クエリはこれらの写しだけを見る。`hashtags` 以外は先頭の1件で、解決できなければキーごと持たない。
// `hashtags` は `tag` の Hashtag の名前を正規化した配列で、空ならキーごと持たない (→ ADR-0103)。
export const OBJECT_QUERY_META_KEYS = [
	'attributedTo',
	'inReplyTo',
	'preferredUsername',
	'hashtags',
] as const;

export type ObjectQueryMetaKey = (typeof OBJECT_QUERY_META_KEYS)[number];

export interface ObjectQueryMeta {
	attributedTo?: string;
	inReplyTo?: string;
	preferredUsername?: string;
	hashtags?: string[];
}

// 各写しの元になる object のフィールド。部分更新ではこのフィールドを含むときだけ写しを書き直す。
export const OBJECT_QUERY_META_SOURCES: Record<ObjectQueryMetaKey, string> = {
	attributedTo: 'attributedTo',
	inReplyTo: 'inReplyTo',
	preferredUsername: 'preferredUsername',
	hashtags: 'tag',
};

// object の現在の内容から、あるべき検索用の `_meta` を計算する。
export const buildObjectQueryMeta = (object: { [key: string]: unknown }): ObjectQueryMeta => {
	const meta: ObjectQueryMeta = {};
	const attributedTo = toIdArray(object.attributedTo)[0];
	if (attributedTo !== undefined) {
		meta.attributedTo = attributedTo;
	}
	const inReplyTo = toIdArray(object.inReplyTo)[0];
	if (inReplyTo !== undefined) {
		meta.inReplyTo = inReplyTo;
	}
	const preferredUsername = toStringValue(object.preferredUsername);
	if (preferredUsername !== undefined) {
		meta.preferredUsername = preferredUsername;
	}
	const hashtags = getObjectHashtags(object);
	if (hashtags.length > 0) {
		meta.hashtags = hashtags;
	}
	return meta;
};

// `streams` ドキュメントの `_meta` に非正規化する検索用フィールド (→ ADR-0096)。
// タイムライン検索の対象となる Announce アクティビティのみを対象とする。
export const ACTIVITY_QUERY_META_KEYS = ['actor'] as const;

export type ActivityQueryMetaKey = (typeof ACTIVITY_QUERY_META_KEYS)[number];

export const buildActivityQueryMeta = (activity: {
	[key: string]: unknown;
}): Partial<Record<ActivityQueryMetaKey, string>> => {
	if (!isAPAnnounce(activity)) {
		return {};
	}
	const actor = toIdArray(activity.actor)[0];
	return actor === undefined ? {} : { actor };
};
