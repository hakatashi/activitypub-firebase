# ADR-0021: `_meta` の非正規化インデックスを map 型の `_meta.index.*` に統一する

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

`_meta` の非正規化フィールドには3つの問題がある。

1. **配列どうしを組み合わせられない。** Firestore は1クエリにつき `array-contains` を1つしか
   使えない(ADR-0019 で実機確認)。`_meta.objectIds`/`_meta.actorIds`([ADR-0020](0020-denormalize-actor-object-ids.md))も
   `_meta.collection`([ADR-0017](0017-meta-collection-as-array.md))も配列のため、
   `findActivityByCollectionAndObjectId`/`ActorId` は片方だけを Firestore に絞り込ませ、
   残りをアプリケーション側でフィルタしている([Issue #73](https://github.com/hakatashi/activitypub-firebase/issues/73))。
2. **`updateObjectCopies` のクエリが常に0件。** `where('object.id', '==', ...)` のドット記法は
   マップ型の中身にしか届かず、常に配列である `object` の要素には届かない
   ([Issue #72](https://github.com/hakatashi/activitypub-firebase/issues/72))。
3. **`_meta.objectType`/`objectTypes` は埋め込みのときしか埋まらない。** `object` が IRI 文字列で
   届く Undo/Accept などでは常に空になり、これで Firestore 側を絞り込むと対象を静かに取りこぼす。
   使用箇所は `mastodon/api.ts` の `getFollowers` 1箇所のみ
   ([Issue #74](https://github.com/hakatashi/activitypub-firebase/issues/74))。

## 決定

1. **非正規化インデックスを `_meta.index.collections` / `_meta.index.actors` / `_meta.index.objects`
   の3つの map(`{ [escapeFirestoreKey(IRI)]: true }`)に統一する。** `_meta.actorIds`/`_meta.objectIds`
   は廃止する。等価条件どうしは Firestore が単一フィールドインデックスの index merging で処理でき、
   複合インデックスの定義が要らない(動的キーには定義もできない)。IRI はドットを含むため、
   クエリのフィールドパスは必ず `new FieldPath('_meta', 'index', field, escapeFirestoreKey(iri))` で組む。
2. **apex が読み書きする `_meta.collection`(配列)は残し、`_meta.index.collections` はその写しとする。**
   `getStream`/`getStreamCount` は実績のある `_meta.collection` の `array-contains` +
   既存の複合インデックスを維持し、map は複数条件を組み合わせるクエリだけで使う。
3. **`_meta.index.*` は Firestore に絞り込ませるためだけに使う。** 取得済みドキュメントに対する
   判定は生の `actor`/`object` + `toIdArray` で行い、トリガーの遅延に依存させない。
4. **`_meta.objectType`/`_meta.objectTypes` を削除する。** `getFollowers` は Undo の
   `_meta.index.objects`(= `toIdArray` で解決済みの Follow の IRI)で打ち消しを判定する。
5. **`updateObjectCopies` は `_meta.index.objects` で引き、配列を配列のまま差し替える。**
   置換対象は MongoDB 実装の `arrayFilters` と同じく `id` が一致する埋め込みオブジェクト要素のみとし、
   IRI 文字列の要素は触らない。

## 理由

- 3つの問題はいずれも「配列に対する Firestore の制約」と「埋め込み表現への依存」に由来しており、
  map 化と `toIdArray` への統一で同時に解ける。
- `_meta.collection` を apex の意味論(`hasMeta` が `Array.isArray` を要求する)から動かさないことで、
  ADR-0017 が撤去した配列⇄スカラーの変換層を復活させずに済む。

## 結果

- 既存の `streams` は `functions/bin/denormalizations.ts` のバックフィルが必要。実行するまで
  `findActivityByCollectionAnd*Id` と `getFollowers` は空を返す。
- `firestore.indexes.json` の複合インデックスのうち、`_meta.objectIds`/`_meta.actorIds`/`_meta.objectType`
  を含む3件は不要になる。`_meta.collection` + `__name__` の1件のみ残る。

## 参照

- Supersedes [[0020-denormalize-actor-object-ids]]
- 関連 Issue: [#72](https://github.com/hakatashi/activitypub-firebase/issues/72),
  [#73](https://github.com/hakatashi/activitypub-firebase/issues/73),
  [#74](https://github.com/hakatashi/activitypub-firebase/issues/74)
- `functions/src/meta.ts`, `functions/src/denormalizations.ts`, `functions/src/store.ts`,
  `functions/src/mastodon/api.ts`, `functions/bin/denormalizations.ts`
