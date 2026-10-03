# Mastodon API 実装状況

`functions/src/mastodon/api.ts` および `oauth.ts` の実装状況。
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
| GET | `/api/v1/accounts/lookup` | ✅ | ローカル acct 解決、未存在・他ドメインは 404 |
| GET | `/api/v1/accounts/:id` | ✅ | アカウント詳細表示 |
| GET | `/api/v1/accounts/:id/statuses` | ✅ | actor 絞り込みと可視性判定、ページネーション対応 |
| GET | `/api/v1/accounts/:id/followers` | ✅ | ページネーション対応(カーソルは Follow の Mastodon ID) |
| GET | `/api/v1/accounts/:id/following` | ✅ | ページネーション対応(カーソルは Follow の Mastodon ID) |
| GET | `/api/v1/accounts/relationships` | ✅ | フォロー・被フォロー・申請中の実データから Relationship を返却 |
| POST | `/api/v1/accounts/:id/follow` / `unfollow` | ✅ | Follow / Undo(Follow) 配送、Relationship 返却 |
| GET | `/api/v1/preferences` | ✅ | 固定値を返す |

## 投稿

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| POST | `/api/v1/statuses` | ✅ | `Idempotency-Key`(1時間)対応。`media_ids` / `poll` / `scheduled_at` は 422。メンション・リンクの自動変換は未対応 |
| GET | `/api/v1/statuses/:id` | ✅ | 可視性判定あり。未存在・権限なしは 404 |
| DELETE | `/api/v1/statuses/:id` | ✅ | `write:statuses` 必須。自分の投稿のみ。Tombstone 化、outbox 配送、statuses_count 減算、本文 (text) を返却 |
| GET | `/api/v1/statuses/:id/context` | ✅ | ancestors (上限40、古い順) / descendants (DFS、深さ20・件数60上限)。手元のみ探索、循環参照ガード |
| POST | `/api/v1/statuses/:id/favourite` / `unfavourite` | ⬜ | |
| POST | `/api/v1/statuses/:id/reblog` / `unreblog` | ⬜ | |
| POST | `/api/v1/statuses/:id/bookmark` / `unbookmark` | ⬜ | |
| POST | `/api/v2/media` | ⬜ | Cloud Storage 連携が必要 |

## タイムライン

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/timelines/public` | ✅ | public のみ。ページネーション対応 |
| GET | `/api/v1/timelines/home` | ✅ | 自分 + フォロー中、閲覧可能なもののみ。ページネーション対応 |
| GET | `/api/v1/timelines/tag/:hashtag` | ⬜ | |
| — | ページネーション + `Link` ヘッダ | ✅ | `max_id`/`since_id`/`min_id`/`limit`、`Access-Control-Expose-Headers: Link`(→ [ADR-0062](adr/0062-cursor-pagination-by-mastodon-id.md)) |

## 通知・その他

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/notifications` | ⬜ | |
| GET | `/api/v1/notifications/unread_count` | ⬜ | |
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
`/api/v1/accounts/:id/featured_tags`

## 実装しないもの

- **ストリーミング API 全般**(→ [ADR-0007](adr/0007-no-streaming-api.md))
- **Web Push**(`POST /api/v1/push/subscription`)
- **管理 API**(`/api/v1/admin/**`)
- **複数アカウントの登録・管理**(→ [ADR-0005](adr/0005-single-user-multi-ready-data-model.md))
