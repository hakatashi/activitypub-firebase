# ADR-0089: 通知 API の実装と組み立て・ページネーション・未読管理の仕様

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Issue #222。#221(ADR-0088)で受信アクティビティを `userInfos/{actor}/notifications` に射影したため、
これをもとに Mastodon の通知 API を実装し、Elk / Phanpy の通知タブおよび未読バッジを動作させる。

## 決定

1. **エンドポイント。** `functions/src/mastodon/routes/notifications.ts` を新設し、次のルートを実装する:
   - `GET /api/v1/notifications` (`read:notifications`): 新しい順。`types[]` / `exclude_types[]` / `account_id` フィルタ。
   - `GET /api/v1/notifications/:id` (`read:notifications`): 1件取得。なければ 404。
   - `POST /api/v1/notifications/clear` (`write:notifications`): 全件削除。
   - `POST /api/v1/notifications/:id/dismiss` (`write:notifications`): 1件削除。
   - `GET /api/v1/notifications/unread_count` (`read:notifications`): 未読通知数。
   - `GET /api/v2/notifications/policy`: 既定値ポリシーのスタブ(ADR-0067)。
   - `GET /api/v1/notifications/requests`: 空配列のスタブ(ADR-0067)。
2. **エンティティの組み立てと除外。** `functions/src/mastodon/presenters/notification.ts` で一括変換する。
   `account` は `userIdsToAccounts`、`status` は `notesToStatuses`(閲覧者を渡す)で組み立てる。
   actor が存在しない・Note が Tombstone や閲覧不可の通知は組み立てずに除外して 500 を防ぐ。
   単一取得で組み立て不能な通知は 404 とする。
3. **読み足しと Link ヘッダ。** タイムライン(ADR-0061)と同様に、除外やフィルタで `limit` 件に満たない場合は
   カーソルを進めて最大5ラウンドまで読み足す。Link ヘッダのカーソル(`max_id`, `min_id`)は、
   除外分を含めて読んだ全レコードの端の ID とし、空ページで止まったり重複スキャンするのを防ぐ。
4. **未読数の集計。** `markers` の `notifications.last_read_id` を下限とし、Firestore の `count()` 集計
   (フィルタがある場合はメモリ内集計)で `limit`(既定 100、最大 1000)内の件数を算出する。

## 結果

- Elk / Phanpy の通知一覧・通知個別表示・全消去・1件削除・未読バッジが動作する。
- 破損データや削除済み Note による 500 エラーを防ぎ、一貫したページネーションを提供できる。

## 参照

- [[0062-cursor-pagination-by-mastodon-id]]、[[0067-stubs-markers-and-instance-info]]、[[0088-project-notifications-in-store]]
- 関連 Issue: [#222](https://github.com/hakatashi/activitypub-firebase/issues/222)
