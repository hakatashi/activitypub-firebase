# ADR-0114: 配送時の 401 / 408 / 429 を一時エラーとして再試行する

- **Status:** Accepted
- **Date:** 2026-10-11

## 背景

[ADR-0003](0003-delivery-via-cloud-tasks.md) および [ADR-0012](0012-delivery-results-in-firestore.md) では、500 未満のレスポンスをすべて恒久失敗 (`permanent_failure`) としてリトライせず破棄していた。
しかし Mastodon の配送ワーカー (`ActivityPub::DeliveryWorker`, `json_ld_helper.rb`) は 401 (署名検証時の一時的な鍵取得失敗等)、408 (タイムアウト)、429 (レート制限) を一時エラーとして再試行対象としている。
特にアカウント移行直後は同一サーバー (pawoo.net 等) への Accept 配送が集中し、一時的な 429 や 401 が発生しやすい。これらを恒久失敗として破棄すると Accept が再送されず、相手側がフォロー承認待ちのまま永久に止まる (Issue #261)。

## 決定

1. **401 / 408 / 429 を再試行対象に変更する。** `deliveryTask` (`functions/src/tasks.ts`) でこれらのステータスコードを受信した場合、`deliveries` コレクションに `status: 'retrying'` として記録した上でエラーを throw し、Cloud Tasks の再試行に委ねる。
2. **その他の 4xx は恒久失敗として破棄を維持する。** 400, 403, 404, 410, 422 等は従来どおり `status: 'permanent_failure'` を記録して正常終了する。
3. **Retry-After の扱い:** `deliveryTask` ではタスクの再エンキューは行わず、Cloud Tasks のキュー設定 (`retryConfig`: 指数バックオフ、`minBackoffSeconds: 10`) に再試行間隔を委ねる。
4. **再試行回数:** 現行の `maxAttempts: 5` を維持する。

## 理由

- Mastodon の `response_error_unsalvageable?` と整合し、コールドスタート起因の 401 や一時的レート制限 (429) による Accept 配送欠落を防げる。
- `Retry-After` を尊重してタスクを新しく積み直す (`enqueue` with `scheduleTime`) 方式は、Cloud Tasks の試行回数 (`request.retryCount`) がリセットされて無限再試行のリスクを生む。Mastodon 自身も `Retry-After` を解析せず Sidekiq の指数バックオフに委ねており、Cloud Tasks のバックオフ (10s〜) で十分な冷却期間が得られる。
- 401 が鍵設定の根本的不一致による恒久的なエラーである場合でも、`maxAttempts: 5` の上限によって無駄な再試行の長期継続を防げる。5 回失敗後も `deliveries` コレクションに `retrying` (attempts: 5) として残り、管理 API からの手動再送が可能。

## 結果

- 401 / 408 / 429 による一時的失敗で配送が破棄されず、Cloud Tasks により自動再試行される。
- `docs/architecture.md` の配送仕様記述を更新する。

## 参照

- 関連 ADR: [[0003-delivery-via-cloud-tasks]]、[[0012-delivery-results-in-firestore]]
- 関連 Issue: [#261](https://github.com/hakatashi/activitypub-firebase/issues/261), [#10](https://github.com/hakatashi/activitypub-firebase/issues/10)
- 参考実装: `third_party/mastodon/app/helpers/json_ld_helper.rb`, `third_party/mastodon/app/workers/activitypub/delivery_worker.rb`
