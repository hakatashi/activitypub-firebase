# ADR-0019: `findActivityByCollectionAndObjectId`/`ActorId` は片方だけを Firestore に絞り込ませる

- **Status:** Superseded by ADR-0020
- **Date:** 2026-09-06

## 背景

`activitypub-express/store/interface.js:22,26` の `findActivityByCollectionAndObjectId` /
`findActivityByCollectionAndActorId` が `store.ts` に未実装で、Undo(Block/Follow)や
Reject の検証(`net/validators.js:332,339,346`)が `Not implemented` で落ちる(Issue #49)。

MongoDB 実装(`store/index.js:145-160`)は
`{ '_meta.collection': collection, object: objectId }` という単純な等価一致クエリで、
`_meta.collection` と `object`/`actor` はどちらも配列だが MongoDB は配列への暗黙のマッチを
行うため意識せずに動く。Firestore で素直に対応させると
`.where('_meta.collection', 'array-contains', collection).where('object', 'array-contains', objectId)`
になるが、これは実機の Firestore エミュレータで
`FAILED_PRECONDITION: Only a single array-contains clause is allowed in a query`
となり実行できない(1クエリにつき `array-contains` は1つまでという制限)。

## 決定

**`object`/`actor` 側(呼び出し元が渡す対象アクターの IRI という、値の選択性が高い方)だけを
Firestore の `array-contains` で絞り込み、`_meta.collection` への所属はアプリケーション側の
`Array.prototype.find` で判定する。**

- `findActivityByCollectionAndObjectId`: `.where('object', 'array-contains', objectId)` の
  結果から `_meta.collection.includes(collection)` を満たす最初の1件を返す。
- `findActivityByCollectionAndActorId`: `.where('actor', 'array-contains', actorId)` の
  結果から同様に絞り込む。
- 単一フィールドの `array-contains` のみのクエリのため、複合インデックスの追加は不要
  (Firestore は単一フィールドを自動でインデックスする)。

## 理由

- このプロジェクトは単一ユーザー運用(`@hakatashi@hakatashi.com` の1人のみ)であり、
  特定の対象アクター IRI に一致する `streams` ドキュメント数は小さい。全件取得して
  アプリケーション側でフィルタしても性能上の問題にならない。
- `_meta.collection` 側を Firestore に絞り込ませる設計(先に `_meta.collection` で
  絞ってから `object`/`actor` をアプリ側で判定する)も同じ制約に当たるが、
  対象アクター IRI の方が値の選択性が高く、取得件数を小さく保てる。

## 結果

- Issue #49 が想定していた「複合インデックスの追加」は不要だった
  (2つの `array-contains` を組み合わせるクエリ自体が Firestore で書けないため)。

## 参照

- 関連 Issue: [#49](https://github.com/hakatashi/activitypub-firebase/issues/49)
- `functions/src/store.ts`
