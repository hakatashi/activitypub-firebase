# ADR-0023: Firestore のコレクションは TypeScript 型で守り、読み出し時に検証しない

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

Firestore のドキュメントは既定で `DocumentData`(= `{ [key: string]: any }`)として扱われ、
読み出した値がそのまま `any` として広がる。`schema.ts:23` と `mastodon/oauth2Model.ts:23-29`
では既に `db.collection('userInfos') as CollectionReference<UserInfo>` の形で型を与えているが、
この扱いはコレクションごとにばらばらで、`store.ts` などは `db.collection('objects')` を
無名のまま直接呼んでいる。

## 決定

1. **自前コレクションのスキーマを TypeScript 型として定義し、`db.collection(...)` の呼び出しを
   `functions/src/schema.ts` に集約する。** 他のファイルからは `Deliveries` のような
   名前付きの `CollectionReference<T>` だけを使う。対象は `deliveries` / `userInfos` /
   `accessTokens` / `refreshTokens` / `authorizationCodes` / `clients` / `users` / `contexts`。
2. **`objects` / `streams` は例外とし、厳密なスキーマ化を目指さない。** これらは AP オブジェクト
   そのものであり、外部インスタンスが送ってくる任意のプロパティを保持する。型は
   `APObject & { id: string; _meta?: ObjectMeta }` 相当に留める。
3. **保存済みデータはスキーマに適合するものとして扱い、読み出し時のランタイム検証を行わない。**
   その代わり、**スキーマを変更する変更は既存データのバックフィルを伴わなければならない。**
4. **書き込みの型を `CollectionReference<T>` に任せきらない。** `update()` の `UpdateData<T>` は
   ドット記法のフィールドパスに対して実質的に無検査であり、`_meta.index.*` のような動的パスには
   型が効かない。動的パスは `meta.ts` の `metaIndexPath()` のようなパス生成関数を経由する。
5. **読み型と書き型が食い違う場合は型を分ける。** `Timestamp` / `Date`、`FieldValue`
   (`increment` や `arrayUnion`)、`undefined` の扱いは読み書きで非対称であり、
   1つの型で両方を表すと型が嘘をつく。

## 理由

- 既に2ファイルで実践している方式であり、新しい仕組みを持ち込まずに全体へ広げられる。
- 読み出し時の検証を入れない代わりに、キャストの発生箇所が `schema.ts` の1ファイルに閉じる。
  「`as` の総数」ではなく「`as` の置き場所」を規約にできる(→ [[ADR-0026]])。
- `objects` / `streams` にまで厳密なスキーマを課すと規約が守れず形骸化する。
  最初に例外を明示するほうが規約が生き残る。

## 結果

- スキーマ変更のたびにバックフィルスクリプト(`functions/bin/`)の追加が必要になる。
  `_meta.index` の map 化(ADR-0021)と同じ運用を常態化させる。
- 過去データがスキーマから外れていた場合、検証がないため型と実体がずれたまま動く。
  dev 環境は破壊してよいため、確認が要るのは本番のバックフィル完了のみ。

## 参照

- [[ADR-0021]], [[ADR-0026]], [[ADR-0027]]
- `functions/src/schema.ts`, `functions/src/mastodon/oauth2Model.ts`,
  `functions/src/store.ts`, `functions/src/meta.ts`
