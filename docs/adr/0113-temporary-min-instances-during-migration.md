# ADR-0113: アカウント移行時の一時的な最小インスタンス数設定

- **Status:** Accepted
- **Date:** 2026-10-11

## 背景

Move アクティビティを受信したリモート Mastodon は、移行先 actor と WebFinger を同期取得して alsoKnownAs を検証する。Mastodon の HTTP クライアントタイムアウトは接続 5 秒・読み取り 10 秒・全体 30 秒で、取得失敗時は Move が再試行されずフォロワー移行が放棄される。現在の `activitypub` Function は `minInstances = 0` のためコールドスタートに 15 秒以上かかることがあり、42 ドメインからの集中アクセスで脱落が発生する恐れがある。

## 決定

1. **対象:** `activitypub` Function のみに最小インスタンス数を設定する。`deliveryTask` は Cloud Tasks の自動再試行があるため対象外とする。
2. **期間:** 通常運用時は設定せず (`minInstances: 0`)、アカウント移行の前後期間 (約 1 週間) のみ `minInstances: 1` を設定する。
3. **切り替え方法:** `params.defineInt('ACTIVITYPUB_MIN_INSTANCES', { default: 0 })` を導入し、移行時のみパラメータで `1` を指定してデプロイする。移行後はデフォルト (0) に戻す。
4. **リソース:** concurrency 80、memory 256MiB、timeout 60s の既定値を維持する。
5. **CDN キャッシュ:** actor や WebFinger への Hosting CDN キャッシュは導入しない。

## 理由

- **費用対効果:** 256MiB の 1 インスタンス常時待機は月額 $2.88 (約 450 円) かかるが、移行前後の 1 週間限定であれば約 $0.67 (約 100 円) で済む。
- **目標達成:** ウォーム状態では WebFinger / actor ともに p50 約 420ms、p99 約 600〜780ms で応答し、目標の p99 < 2 秒および 10 秒のタイムアウト制限を安全にクリアできる。
- **CDN キャッシュ不採用:** `skip_cache: true` でも CDN キャッシュが無効化されない場合、古い actor を返して移行検証が失敗するリスクがある。ウォーム化だけで十分な性能が得られるため不要。

## 結果

移行期間中のコールドスタートによるフォロワー移行失敗を防ぎつつ、定常運用時の無駄な待機コストをゼロに抑えられる。移行手順書 (#270) に `ACTIVITYPUB_MIN_INSTANCES=1` のデプロイおよび移行完了後の解除手順を記載する必要がある。

## 参照

- 関連 Issue: #262, #10, #270
- 関連コード: `functions/src/activitypub.ts`
- 関連ドキュメント: `docs/architecture.md`, `docs/runbooks/federation-testing.md`
