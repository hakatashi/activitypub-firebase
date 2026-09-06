# ADR-0022: `getStream` の `blockList` フィルタをアプリケーション側で行う

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

`getStream`(`functions/src/store.ts`)は `blockList` 指定時に `.where('actor', 'not-in', blockList)`
を追加していたが、Firestore は `not-in` を使うクエリの最初の `orderBy` にそのフィールドを
要求するため、`orderBy(FieldPath.documentId(), 'desc')` と両立できず
`3 INVALID_ARGUMENT` で失敗していた(Issue #31)。
また Firestore の `not-in` は最大10件の制限があり、`actor` が配列やオブジェクトの場合に
正しくマッチしない問題もあった。

## 決定

**`blockList` による除外を Firestore クエリから撤廃し、`getStream` のアプリケーション側で
`toIdArray(activity.actor)` を用いてフィルタリングする。**

- Firestore クエリは `_meta.collection` と `documentId` 降順のソート・カーソルを維持する。
- `limit` 指定時は、ブロックされたアクティビティによって返却件数が不足した場合に
  `documentId` カーソルを進めて `limit` 件に達するまで(または終端まで)追従取得する。
- `actor` の IRI 判定は `toIdArray` に統一し、配列や埋め込みオブジェクトにも対応する。

## 理由

- Firestore の `not-in` 制約(`orderBy` 制約および 10 件上限)を完全に回避できる。
- `toIdArray` により、AS2 の多様な `actor` 表現(IRI 文字列・Link・埋め込みオブジェクト・配列)
  に対して一貫したブロック判定ができる。
- 単一ユーザー運用のためブロック対象アクティビティが大量に連続することは稀であり、
  不足分のみカーソルで追従取得することで最小限のクエリ回数で正確な件数を返せる。

## 結果

- `blockList` を渡したコレクション取得(`getInbox`, `getFollowers` 等)が正常に動作する。
- 複合インデックスの追加は不要。

## 参照

- 関連 Issue: [#31](https://github.com/hakatashi/activitypub-firebase/issues/31)
- `functions/src/store.ts`, `functions/src/utils.ts`
