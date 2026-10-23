# ADR-0157: identity/v1 JSON-LD コンテキストの静的バンドル

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

`@context` に `https://w3id.org/identity/v1` を含むアクティビティを受信した際、同 URL のリダイレクト先である `web-payments.org` が応答不能（接続不可）になっているため、apex の `jsonldContextLoader` が一時的な取得失敗とみなして 503 を返し続ける問題が発生した (#325)。
GoToSocial 等の外部インスタンスからの Follow が恒久的に弾かれ続ける原因となる。Mastodon や Misskey もこのコンテキストを静的に同梱して外部取得を回避している。

## 決定

1. **identity/v1 の静的バンドル:** `functions/src/apex/vocab/identity.json` を配置し、Misskey・Mastodon と同一の定義 (76 項目) を格納する。
2. **`coreContexts` への登録:** apex フォークの `coreContexts` に `https://w3id.org/identity/v1` および `http://w3id.org/identity/v1` を登録し、外部リクエストや Firestore `contexts` キャッシュの検索を行わずインメモリで即時解決する。

## 理由

- 配信元サーバが消滅しているため、外部 HTTP 取得は常に失敗する。静的バンドルによりネットワーク fetch なしで安全に解釈できる。
- ADR-0117 (`webfinger`) と同様、apex のフォーク側 (`functions/src/apex/pub/utils.ts`) に閉じることで本体コードに回避処理を持ち込まず責務境界を維持できる (ADR-0042)。
- `http://` もキーに含めておくことで、スキーマ表記の揺れによる意図せぬ外部 fetch と 503 を未然に防ぐ。

## 結果

`https://w3id.org/identity/v1` を持つアクティビティがネットワークなしで正常に処理され、inbox の 503 返送が解消する。

## 参照

- 関連 Issue: #325
- 関連 ADR: [ADR-0042](0042-apex-fork-responsibility-boundary.md), [ADR-0115](0115-inbox-4xx-only-for-sender-faults.md), [ADR-0117](0117-bundle-webfinger-core-context.md)
