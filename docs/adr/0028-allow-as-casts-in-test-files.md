# ADR-0028: 型アサーションの配置ルールにテストファイルの例外を加える

- **Status:** Accepted
- **Date:** 2026-09-07

## 背景

[[ADR-0026]] ルール3は `as T` を `functions/types/*.d.ts` / `functions/src/schema.ts` /
zod の parse 関数の内部にのみ許可し、それ以外を禁止した。しかし同じ PR (#83) で
`catch (err: any)` や `as any` を排除する過程で、`functions/test/**/*.spec.ts` にも
`as unknown as X` が新規に持ち込まれた(例: `oauth.spec.ts` の
`applicationDefault` のモック戻り値、`tasks.spec.ts`/`denormalizations.spec.ts` の
Cloud Functions イベント引数の組み立て)。ルール3の文言はテストファイルを除外しておらず、
この PR 自身がルール3に違反する状態になっていた。

## 決定

**`functions/test/**/*.spec.ts` を、[[ADR-0026]] ルール3の許可リストに追加する。**
モック値・イベントペイロードなど、テスト用のフィクスチャを組み立てる `as unknown as X` に限り
許可する。プロダクションコード(`functions/src/**`, `functions/bin/**`)には引き続き
ルール3をそのまま適用する。

## 理由

- テストが構築するダミーオブジェクトは外部ライブラリの型(`firebase.credential.Credential`、
  Cloud Functions の `CloudEvent`、`@node-oauth/oauth2-server` の `Token`/`AuthorizationCode`
  など)の一部フィールドしか要求しない。全フィールドを満たす型ガードや正規化ヘルパーを
  テストのためだけに用意すると、実装コードより複雑になり保守コストが実利を上回る。
- テストのキャストはリクエスト/レスポンスの実データに触れないため、[[ADR-0026]] が防ぎたい
  「実行時の型の穴が本番データに波及する」リスクがそもそも小さい。
- 配置ルールを「ファイルパスで機械的に判定できる」という [[ADR-0026]] の狙いは、
  許可リストにディレクトリパターンを1つ足すだけで維持できる。

## 結果

- `functions/test/**/*.spec.ts` 以外(`functions/src/**`, `functions/bin/**`)での
  `as T` は引き続き [[ADR-0026]] ルール3の対象。

## 参照

- [[ADR-0026]]
- `functions/test/integration/oauth.spec.ts`, `functions/test/unit/tasks.spec.ts`,
  `functions/test/unit/denormalizations.spec.ts`
