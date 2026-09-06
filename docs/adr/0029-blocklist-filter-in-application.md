# ADR-0029: `getStream` の `blockList` フィルタはアプリケーション側で行う

- **Status:** Accepted
- **Date:** 2026-09-07

## 背景

`functions/src/store.ts` の `getStream` は `blockList` が渡されると
`.where('actor', 'not-in', blockList)` を Firestore クエリに追加していたが、`orderBy` は常に
`FieldPath.documentId()` のみだった。Firestore は `not-in` を使うクエリでは、そのフィールドを
最初の `orderBy` にすることを要求するため、この組み合わせは
`3 INVALID_ARGUMENT: order by clause cannot contain more fields after the key` で必ず失敗する
(Issue #31)。

`orderBy` を `actor` → `documentId()` の順に変更する案も検討したが、ページネーションの
カーソルが `documentId()` の単純な `<` 比較(ADR なし、Issue #48 で修正済みの実装)から
複合カーソル(`actor` と `documentId()` の組)に変わり、`getStream` の呼び出し規約
(`after` は前ページ最終要素の `_id` 一つ)を壊さずには実装できない。

## 決定

**`not-in` による Firestore 側のフィルタをやめ、`blockList` によるフィルタは取得後の
アプリケーション側で行う。** `actor` フィールドは IRI 文字列・配列・埋め込みオブジェクトの
いずれにもなりうるため、`toIdArray`(→ ADR-0025 系のヘルパー)で正規化してから
`blockList` に含まれるか判定する。

## 理由

- Firestore の `not-in` は比較対象を10件までしか受け付けない制限もあり、素の `not-in` では
  そもそも `blockList` の件数によっては別の理由で失敗する。アプリ側フィルタはこの制限も回避する。
- ADR-0019 と同じ理由(単一ユーザー運用で `streams` の該当件数が小さい)により、
  取得後にアプリ側でフィルタしても性能上の問題にならない。
- `orderBy`/カーソルの構造を変えずに済み、Issue #48 で修正したページネーションの挙動に
  影響を与えない。

## 結果

- `limit` 指定時、フィルタ後の件数が `limit` より少なくなりうる(Firestore 側で `limit`
  件取得してからアプリ側で間引くため)。ブロック機能が実装されるまでは `blockList` が
  常に空配列なので実害はない。ブロック機能実装時にページ内件数が目減りする問題が
  顕在化するなら、その時点で改めて対処する。

## 参照

- 関連 ADR: [[0019-find-activity-by-collection-object-actor]]、[[0025-normalize-ap-objects-instead-of-casting]]
- 関連 Issue: [#31](https://github.com/hakatashi/activitypub-firebase/issues/31)
- 関連コード: `functions/src/store.ts`、`functions/src/utils.ts`
