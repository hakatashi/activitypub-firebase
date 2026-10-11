# ADR-0117: WebFinger JSON-LD コンテキストのバンドルとリソース割り当て検証

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

Mastodon (4.3/4.7) の actor や activity の `@context` に含まれる `https://purl.archive.org/socialweb/webfinger` が apex の `coreContexts` に登録されておらず、リクエスト毎に Firestore `Contexts` への読み取りと `jsonld.compact` の解決オーバーヘッド (約 470ms〜1.5s) が発生していた (#282)。
また Follow 殺到時の 10 秒タイムアウト対策として Cloud Run のリソース割り当て (concurrency 引き下げ、CPU/メモリ増強) を dev 環境で実地検証したが、コールドスタート遅延や同期 postWork (`acceptAndPublishFollow`) の直列化により、リソース見直し単体では 10 秒タイムアウトが解消しないことが判明した。

## 決定

1. **WebFinger コンテキストの静的バンドル:** `functions/src/apex/vocab/webfinger.json` を配置し、apex フォークの `coreContexts` に `https://purl.archive.org/socialweb/webfinger` を登録してインメモリ解決する。
2. **リソース割り当ての維持:** `activitypub` Function のリソース割り当て (concurrency 80, memory 256MiB, CPU 既定) は ADR-0113 の決定通り維持する。

## 理由

- `webfinger` コンテキストをインメモリに事前保持することで、Firestore への都度クエリをゼロにし、`jsonld.compact` の単体処理時間を約 2ms へ大幅に高速化できる。
- リソース割り当ての見直し (concurrency 8 や 2 vCPU/2GiB) は、コールドスタート待ちや同期処理の競合により単体ではタイムアウトを防止できず、無駄な待機コストを招くため既定値を維持する。

## 結果

頻出外部 `@context` の解決オーバーヘッドが完全に削減され、inbox 受信時の CPU 負荷と Firestore 読み取り回数が削減される。Follow 殺到時のタイムアウトに対する postWork の同期処理等の抜本的改善は別タスクで扱う。

## 参照

- 関連 Issue: #282, #271, #10
- 関連 ADR: [ADR-0013](0013-scoped-postwork-middleware.md), [ADR-0042](0042-apex-fork-responsibility-boundary.md), [ADR-0113](0113-temporary-min-instances-during-migration.md)
