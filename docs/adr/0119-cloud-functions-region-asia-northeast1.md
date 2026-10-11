# ADR-0119: Cloud Functions を Firestore と同じ asia-northeast1 へ移行する

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

Firestore は東京 (`asia-northeast1`)、Cloud Functions はデフォルトのアイオワ (`us-central1`) にあり、リクエストごとに太平洋を往復する RPC レイテンシが発生していた。#282 の Follow 500 件殺到負荷試験では、単一ドキュメント読み取りに約 350ms、inbox 全体で p50 5.0s / p99 8.4s を要し、10 秒タイムアウト到達やトランザクション競合の主因となっていた。また、移行元の pawoo.net をはじめフォロワーの多くも日本周辺に位置する。

## 決定

1. **Functions のグローバルリージョン変更:** `functions/src/index.ts` 等で `setGlobalOptions({ region: 'asia-northeast1' })` を宣言し、全関数 (HTTPS, Firestore トリガー, Scheduler, Task Queue) を `asia-northeast1` に配置する。
2. **Hosting Rewrites の明示:** `firebase.json` の Hosting rewrites で、Cloud Functions への転送先を `"function": { "functionId": "...", "region": "asia-northeast1" }` 形式に統一する。
3. **Cloud Tasks キューのリージョン指定:** `getFunctions().taskQueue(...)` のキュー指定を `locations/asia-northeast1/functions/${name}` 形式 (または共通ヘルパー) に変更し、東京のキューへ正しくエンキューする。
4. **移行タイミングとリソース削除:** 引っ越し (#273) 本番での Follow 殺到に備え、引っ越し前にリージョン移行を完了する。旧リージョン (`us-central1`) のリソースは移行検証後に削除する。

## 理由

- Functions と Firestore を同一リージョンに配置することで RPC レイテンシが数ミリ秒に短縮され、トランザクション競合期間の短縮と inbox タイムアウトの回避が実現できる。
- `asia-northeast1` は単価が約 20% 高いが、個人用サーバーの負荷規模では月額数十円〜数百円の差に過ぎず、安定性とレイテンシ向上の価値が上回る。

## 結果

- dev 環境で Follow 殺到試験 (`functions/bin/loadTestFollowRush.sh`) を実施し、inbox のレイテンシが大幅に改善することを確認する。
- 運用スクリプト (`preflightCheck.sh`, `loadTestFollowRush.sh`) およびドキュメントのロケーション指定を `asia-northeast1` に更新する。

## 参照

- 関連 Issue: #285, #282, #273, #10
- 関連 ADR: [ADR-0003](0003-delivery-via-cloud-tasks.md), [ADR-0113](0113-temporary-min-instances-during-migration.md)
