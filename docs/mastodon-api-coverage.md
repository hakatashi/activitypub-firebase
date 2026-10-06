# Mastodon API 実装状況

`functions/src/mastodon/routes/` および `oauth.ts` の実装状況。
**エンドポイントを実装したらこの表を更新する。**

未定義のルートは `api.ts` 末尾のフォールバックで 404 を返す(→ [ADR-0067](adr/0067-stubs-markers-and-instance-info.md))。
クライアントによっては 501 で起動に失敗するため、当面使わないものも
**空配列を返すスタブを置く**方針(→ [ADR-0004](adr/0004-no-custom-ui-use-elk.md))。

凡例: ✅ 実装済み / 🟡 部分的・要修正 / ⬜ 未実装(404)

## 認証・アプリ登録

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| POST | `/api/v1/apps` | ✅ | 文字列・配列形式の `redirect_uris` に対応。トランザクション内で採番 |
| GET | `/api/v1/apps/verify_credentials` | ✅ | Bearer トークンによる認証、機密情報を除外したアプリ情報を返却 |
| GET | `/oauth/authorize` | ✅ | FirebaseUI による Google ログイン画面を返す。PKCE / state 引継ぎ対応 |
| POST | `/oauth/authorize` | ✅ | ID トークン検証後に認可コードを発行。PKCE / state に対応 |
| POST | `/oauth/token` | ✅ | Elk が JSON を送る不具合への workaround あり。refresh_token grant と PKCE 検証に対応 |
| POST | `/oauth/revoke` | ✅ | RFC 7009 準拠。トークン所有者検証、失効および冪等な 200 応答 |
| — | PKCE (`code_challenge`) | ✅ | S256 / plain に対応。認可画面経由での値の保持とトークン交換時の検証 |

## インスタンス情報

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/instance` | ✅ | `urls.streaming_api` は空文字、`UserInfos` 実データを反映 |
| GET | `/api/v2/instance` | ✅ | `version: 4.3.0`、`api_versions`、`urls.streaming` は空文字、`UserInfos` 実データを反映 |
| GET | `/.well-known/nodeinfo`, `/nodeinfo/:version` | ✅ | apex のハンドラを再利用 |
| GET | `/api/v1/streaming` | ✅ | **404 を返す**(→ [ADR-0007](adr/0007-no-streaming-api.md)) |

## アカウント

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/accounts/verify_credentials` | ✅ | 完全な CredentialAccount (source, role 含む) を返却 |
| PATCH | `/api/v1/accounts/update_credentials` | ✅ | 表示名・bio・locked・discoverable・fields 更新、Update 配送 |
| GET | `/api/v1/accounts/lookup` | ✅ | ローカル acct と、手元にキャッシュ済みのリモート actor を解決。WebFinger では取りに行かない (→ [ADR-0073](adr/0073-lookup-cached-remote-accounts.md)) |
| GET | `/api/v1/accounts/:id` | ✅ | アカウント詳細表示。リモートの `url` は相手サーバーのプロフィール URL |
| GET | `/api/v1/accounts/:id/statuses` | ✅ | actor 絞り込みと可視性判定、ページネーション対応、`?pinned=true` 対応。リモートアカウントにも対応 (→ [ADR-0072](adr/0072-match-array-attributed-to-in-note-queries.md)) |
| GET | `/api/v1/accounts/:id/followers` | ✅ | ページネーション対応(カーソルは Follow の Mastodon ID) |
| GET | `/api/v1/accounts/:id/following` | ✅ | ページネーション対応(カーソルは Follow の Mastodon ID) |
| GET | `/api/v1/accounts/relationships` | ✅ | フォロー・被フォロー・申請中の実データから Relationship を返却 |
| POST | `/api/v1/accounts/:id/follow` / `unfollow` | ✅ | Follow / Undo(Follow) 配送、Relationship 返却 |
| GET | `/api/v1/preferences` | ✅ | 固定値を返す |

## 投稿

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| POST | `/api/v1/statuses` | ✅ | `Idempotency-Key`(1時間)対応。`media_ids` / `poll` / `scheduled_at` は 422。メンション・ハッシュタグ・URL を自動変換 (→ [ADR-0071](adr/0071-post-content-formatting-and-mentions.md)) |
| GET | `/api/v1/statuses/:id` | ✅ | 可視性判定あり。未存在・権限なしは 404。favourited / reblogged / bookmarked / pinned を認証ユーザーから判定、media_attachments を Note から導出 (→ [ADR-0070](adr/0070-status-viewer-attributes-and-storage.md)、[ADR-0084](adr/0084-project-favourites-and-reblogs.md)、[ADR-0090](adr/0090-derive-media-attachments-from-note.md)) |
| DELETE | `/api/v1/statuses/:id` | ✅ | `write:statuses` 必須。自分の投稿のみ。Tombstone 化、outbox 配送、statuses_count 減算、本文 (text) を返却 |
| GET | `/api/v1/statuses/:id/context` | ✅ | ancestors (上限40、古い順) / descendants (DFS、深さ20・件数60上限)。手元のみ探索、循環参照ガード |
| POST | `/api/v1/statuses/:id/favourite` / `unfavourite` | ✅ | `write:favourites` 必須。Like / Undo(Like) 配送、Status 返却 (→ [ADR-0070](adr/0070-status-viewer-attributes-and-storage.md)、[ADR-0084](adr/0084-project-favourites-and-reblogs.md)) |
| POST | `/api/v1/statuses/:id/reblog` / `unreblog` | ✅ | `write:statuses` 必須。Announce / Undo(Announce) 配送、Status 返却 (→ [ADR-0070](adr/0070-status-viewer-attributes-and-storage.md)、[ADR-0084](adr/0084-project-favourites-and-reblogs.md)) |
| POST | `/api/v1/statuses/:id/bookmark` / `unbookmark` | ✅ | `write:bookmarks` 必須。`userInfos/{actor}/bookmarks` 保存・削除、Status 返却 (→ [ADR-0070](adr/0070-status-viewer-attributes-and-storage.md)) |
| POST | `/api/v1/statuses/:id/pin` / `unpin` | ✅ | `write:accounts` 必須。自分の投稿のみ(上限5件)、`userInfos/{actor}/pins` 保存・削除、Status 返却 (→ [ADR-0070](adr/0070-status-viewer-attributes-and-storage.md)) |
| POST | `/api/v2/media` | ✅ | `write:media` 必須。同期的に画像処理(EXIF除去・サムネイル・blurhash)を行い Cloud Storage に保存、MediaAttachment 返却 (→ [ADR-0091](adr/0091-media-upload-and-storage.md)) |
| POST | `/api/v1/media` | ✅ | `write:media` 必須。v2 と同一処理で 200 返却 (→ [ADR-0091](adr/0091-media-upload-and-storage.md)) |
| GET | `/api/v1/media/:id` | ✅ | `write:media` 必須。自分のメディアのみ取得可能 (他人は 404) |
| PUT | `/api/v1/media/:id` | ✅ | `write:media` 必須。description / focus の更新。未添付の自分のメディアのみ更新可能 (→ [ADR-0091](adr/0091-media-upload-and-storage.md)) |

## タイムライン

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/timelines/public` | ✅ | public のみ。ページネーション対応 |
| GET | `/api/v1/timelines/home` | ✅ | 自分 + フォロー中、閲覧可能なもののみ。ページネーション対応。リモートの Note (`attributedTo` が配列) も含む (→ [ADR-0072](adr/0072-match-array-attributed-to-in-note-queries.md)) |
| GET | `/api/v1/timelines/tag/:hashtag` | ⬜ | |
| — | ページネーション + `Link` ヘッダ | ✅ | `max_id`/`since_id`/`min_id`/`limit`、`Access-Control-Expose-Headers: Link`(→ [ADR-0062](adr/0062-cursor-pagination-by-mastodon-id.md)) |

## 通知・その他

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/notifications` | ✅ | ページネーション、`types[]` / `exclude_types[]` / `account_id` 絞り込み、読み足し、破損データ安全除外 (→ [ADR-0089](adr/0089-notifications-api.md)) |
| GET | `/api/v1/notifications/:id` | ✅ | 1件取得。なければ 404 (→ [ADR-0089](adr/0089-notifications-api.md)) |
| POST | `/api/v1/notifications/clear` | ✅ | 全件削除 (→ [ADR-0089](adr/0089-notifications-api.md)) |
| POST | `/api/v1/notifications/:id/dismiss` | ✅ | 1件削除 (→ [ADR-0089](adr/0089-notifications-api.md)) |
| GET | `/api/v1/notifications/unread_count` | ✅ | `markers` の `notifications.last_read_id` より新しい通知件数(Firestore `count()` 集計、上限 `limit`) (→ [ADR-0089](adr/0089-notifications-api.md)) |
| GET | `/api/v2/notifications/policy` | ✅ | 既定値ポリシーを返すスタブ (Phanpy 互換、→ [ADR-0089](adr/0089-notifications-api.md)) |
| GET | `/api/v1/notifications/requests` | ✅ | 空配列を返すスタブ (Phanpy 互換、→ [ADR-0089](adr/0089-notifications-api.md)) |
| GET, POST | `/api/v1/markers` | ✅ | `home` / `notifications` の既読位置、`version` による楽観ロック (競合時は 409 Conflict) (→ [ADR-0067](adr/0067-stubs-markers-and-instance-info.md)) |
| GET | `/api/v2/search` | ⬜ | |
| GET | `/api/v1/push/subscription` | ✅ | 404 を返す(Web Push 非対応) |

## 空配列スタブで足りるもの

クライアントの起動時に叩かれるが、シングルユーザー運用では中身が不要なもの。
**501 ではなく空配列 `[]` を返す。**

`/api/v1/custom_emojis`, `/api/v1/filters`, `/api/v2/filters`, `/api/v1/announcements`,
`/api/v1/lists`, `/api/v1/followed_tags`, `/api/v1/conversations`,
`/api/v1/blocks`, `/api/v1/mutes`, `/api/v1/domain_blocks`, `/api/v1/bookmarks`,
`/api/v1/favourites`, `/api/v1/follow_requests`, `/api/v1/featured_tags`,
`/api/v1/accounts/:id/featured_tags`, `/api/v1/notifications/requests`

## 実装しないもの

- **ストリーミング API 全般**(→ [ADR-0007](adr/0007-no-streaming-api.md))
- **Web Push**(`POST /api/v1/push/subscription`)
- **管理 API**(`/api/v1/admin/**`)
- **複数アカウントの登録・管理**(→ [ADR-0005](adr/0005-single-user-multi-ready-data-model.md))
