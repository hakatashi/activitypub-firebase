# ADR-0027: エスケープ済み Firestore キーをブランド型で区別する

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

このプロジェクトは AP の IRI をそのまま Firestore のドキュメント ID として使えない
(`/` を含むため)。`functions/src/firebase.ts` の `escapeFirestoreKey()` で
エンコードした文字列を ID に使っており、`_meta.index.*` の map のキーも同じくエスケープ済みである
([[ADR-0021]])。

問題は、**生の IRI とエスケープ済みキーがどちらも `string` であること。**
取り違えても型では落ちず、Firestore 上は「そのキーのドキュメントが存在しない」という
静かな失敗になる。`objects` / `streams` の `doc()` 呼び出し、`_meta.index` のパス生成
(`metaIndexPath()`)、`mastodon/api.ts` の `UserInfos.doc(escapeFirestoreKey(actorId))` など、
両者が同じ関数の中で並んで現れる箇所が多く、実際に間違えやすい。

## 決定

**`escapeFirestoreKey()` の戻り値と `unescapeFirestoreKey()` の引数をブランド型にする。**

```ts
declare const firestoreKeyBrand: unique symbol;
export type FirestoreKey = string & { readonly [firestoreKeyBrand]: true };
```

`doc()` にキーを渡す箇所、`metaIndexPath()` のキー引数など、エスケープ済みであることを
要求する API は `FirestoreKey` を受け取る。生の `string` を渡すとコンパイルエラーになる。
`FirestoreKey` を生成できるのは `escapeFirestoreKey()` のみとする。

## 理由

- `any` や `as` の削減とは別の軸だが、**このプロジェクトで最も再発しやすい型由来のバグ**が
  ここであり、型で防げる数少ない種類の誤りである。
- ランタイムのコストがゼロで、実行時の表現は今と同じ `string` のまま変わらない。
- 命名規約(`escapedActorId` のような変数名)で運用する案は採らない。すでに同じ関数の中で
  生 IRI とエスケープ済みキーが混在しており、命名だけでは強制力がない。

## 結果

- `escapeFirestoreKey()` を通さずに `doc()` へ渡している箇所が一斉にコンパイルエラーになる。
  そのうち一部は既存のバグである可能性があり、修正時に個別に判断する。
- Firestore から読んだドキュメント ID(`doc.id`)はエスケープ済みだが型は `string` なので、
  `FirestoreKey` として扱う地点で1回だけキャストが必要になる。このキャストは
  [[ADR-0026]] の例外として `functions/src/firebase.ts` に置く。

## 参照

- [[ADR-0021]], [[ADR-0023]], [[ADR-0026]]
- `functions/src/firebase.ts`, `functions/src/meta.ts`, `functions/src/store.ts`
