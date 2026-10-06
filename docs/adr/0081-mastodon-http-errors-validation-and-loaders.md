# ADR-0081: Mastodon API の HttpError、検証ミドルウェア、リソースローダーの導入

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Mastodon API ルート層(ステータス・アカウント系)で、パラメータ検証・リソース取得・可視性判定・認証済み actor 取得の定型処理が多数のハンドラに重複していた。また、`res.locals.actorId as string` などの型キャストが散在し、エラー応答形式のハンドラ個別記述が保守性を下げていた(Issue #191)。

## 決定

1. **HttpError 階層の導入**: `HttpError` (`NotFoundError`, `UnprocessableError` 等) を導入し、ハンドラは throw で脱出する。末尾のエラーハンドラ(ADR-0074)で `{ error }` 形式に集約する。
2. **宣言的検証ミドルウェア `validate`**: zod スキーマによる params/query/body 検証を行い、検証済みデータを `res.locals.valid` に格納して型安全なゲッターで取得する。
3. **ドメインリソースローダーの導入**: `loadStatus`, `loadVisibleStatus`, `loadAccount`, `loadViewer` を導入し、存在確認・可視性検証・型アサーションを集約する。
4. **`res.locals` の型付け**: Express の `Locals` 型を拡張し、`getAuthActorId` などのヘルパーで安全にアクセスして `as ...` キャストを撤廃する(ADR-0026)。

## 理由

ルートハンドラの関心事を HTTP リクエスト/レスポンスのオーケストレーションに絞り、定型的な取得・検証ロジックを共通化することでコードの重複と不具合の混入を防ぐため。

## 結果

- ステータス・アカウント系ハンドラのボイラープレートが大幅に削減される。
- 型キャストが排除され、コンパイル時の型安全性が向上する。
- 既存の API 契約(ステータスコード・ボディ)は一切変更されない。

## 参照

- 関連 ADR: [ADR-0026](0026-ban-any-and-confine-casts-to-boundaries.md), [ADR-0074](0074-mastodon-api-authentication-error-handling.md)
- 関連 Issue: #181, #191
