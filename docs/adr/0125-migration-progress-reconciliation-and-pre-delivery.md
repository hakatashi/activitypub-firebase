# ADR-0125: 引っ越しのフォロワー進捗突き合わせと事前の Update(Person) 配送

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

Mastodon のアカウント引っ越し (Move) は相手サーバーで静かに失敗しうる。相手サーバーで Move や Follow が捨てられても通知はなく、再実行には 30 日のクールダウンを要するため、取りこぼしたフォロワーを正確に特定できる必要がある。
また Mastodon は、配送失敗が 7 日分累積した相手ドメインを `UnavailableDomain` として記録し、以後の配送を破棄する (`DeliveryFailureTracker`)。この状態では引っ越しの Follow も届かないが、相手サーバーの inbox に署名付きリクエストを届ければ解除される。

## 決定

**旧アカウントのフォロワー一覧とローカルのフォロワー射影・配送履歴を突き合わせる CLI スクリプト (`functions/bin/migrationStatus.ts`) と、フォロワー所在サーバーの sharedInbox への事前 `Update(Person)` 配送を実装する。**

1. **フォロワーの取得と保存:** 旧サーバーの Mastodon API (`GET /api/v1/accounts/:id/followers`) から取得し、Move 実行前の状態を JSON として保存・再利用可能にする。
2. **状態分類:** 各フォロワーを「射影済み (followed)」「Follow 受信済みだが未射影 (follow_received_not_projected)」「Accept 配送失敗・再試行中 (accept_delivery_failed)」「Follow 未達 (not_followed)」の 4 状態に分類する。
3. **ドメイン別集計:** サーバー単位で全員が未達ならサーバー側の処理失敗を疑えるよう、ドメインごとの集計表および JSON を出力する。
4. **事前の Update(Person) 配送:** フォロワー一覧の全ドメインから代表フォロワーを通じて `endpoints.sharedInbox` (なければ `inbox`) を抽出し、ローカル actor の `Update(Person)` を `Store#deliveryEnqueue` 経由で配送する。相手サーバーの `UnavailableDomain` 記録を消し、`alsoKnownAs` を含む最新 actor を事前キャッシュさせる。
5. **安全機構:** 本番・dev を問わず、明示的な配送フラグ (`--announce`) がなければ読み取り専用で動作し、`--dry-run` にも対応する。

## 理由

- `UnavailableDomain` に陥っている相手サーバーでは引っ越しの Follow が捨てられ旧フォローも外れるため、事前解除が必須。
- サーバー単位の `sharedInbox` 宛てに 1 通配送すれば、サーバー全体の失敗記録がリセットされ、リクエスト数も最小限で済む。
- 進捗を 4 状態とドメイン別に可視化することで、承認漏れや Accept 配送失敗の再送、手動案内の対象を正確に判断できる。

## 結果

- 引っ越し前後にフォロワーの移行状況を漏れなく追跡でき、`UnavailableDomain` による移行失敗を予防できる。

## 参照

- 関連 Issue: [#267](https://github.com/hakatashi/activitypub-firebase/issues/267), [#10](https://github.com/hakatashi/activitypub-firebase/issues/10)
- 関連 ADR: [ADR-0003](0003-delivery-via-cloud-tasks.md), [ADR-0012](0012-cloud-tasks-delivery-retry-and-monitoring.md), [ADR-0082](0082-project-follow-relations-in-store.md), [ADR-0111](0111-retry-unaccepted-follow-and-500-on-sync-failure.md), [ADR-0121](0121-actor-aliases-via-also-known-as.md)
