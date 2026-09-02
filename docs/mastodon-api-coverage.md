# Mastodon API 実装状況

`functions/src/mastodon/api.ts` および `oauth.ts` の実装状況。
**エンドポイントを実装したらこの表を更新する。**

未定義のルートは `api.ts` 末尾のフォールバックで 501 を返す。
クライアントによっては 501 で起動に失敗するため、当面使わないものも
**空配列を返すスタブを置く**方針(→ [ADR-0004](adr/0004-no-custom-ui-use-elk.md))。

凡例: ✅ 実装済み / 🟡 部分的・要修正 / ⬜ 未実装(501)

## 認証・アプリ登録

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| POST | `/api/v1/apps` | 🟡 | `redirect_uris` の配列形式に未対応。`id` の採番が `count()+1` で競合しうる |
| GET | `/api/v1/apps/verify_credentials` | ⬜ | |
| GET | `/oauth/authorize` | ✅ | FirebaseUI による Google ログイン画面を返す |
| POST | `/oauth/authorize` | ✅ | ID トークン検証後に認可コードを発行 |
| POST | `/oauth/token` | ✅ | Elk が JSON を送る不具合への workaround あり |
| POST | `/oauth/revoke` | ⬜ | 501 固定。`revokeToken` 自体が未実装 |
| — | PKCE (`code_challenge`) | ⬜ | 対応状況未確認 |

## インスタンス情報

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/instance` | 🟡 | `v2` から機械的に導出。`urls.streaming_api` を空にする必要あり |
| GET | `/api/v2/instance` | 🟡 | `version` が `4.0.0` のまま。`api_versions` がない。サンプル値が残存 |
| GET | `/.well-known/nodeinfo`, `/nodeinfo/:version` | ✅ | apex のハンドラを再利用 |
| GET | `/api/v1/streaming` | ⬜ | **404 を返すようにする**(→ [ADR-0007](adr/0007-no-streaming-api.md)) |

## アカウント

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/accounts/verify_credentials` | 🟡 | `UserInfo` を素で返しており CredentialAccount として不完全 |
| PATCH | `/api/v1/accounts/update_credentials` | ⬜ | プロフィール編集 |
| GET | `/api/v1/accounts/lookup` | 🟡 | 他ドメインの acct は `Not implemented` を throw |
| GET | `/api/v1/accounts/:id` | ⬜ | |
| GET | `/api/v1/accounts/:id/statuses` | 🟡 | **`:id` を無視して全 Note を返す** |
| GET | `/api/v1/accounts/:id/followers` | ✅ | ページネーションなし |
| GET | `/api/v1/accounts/:id/following` | ⬜ | |
| GET | `/api/v1/accounts/relationships` | ⬜ | プロフィール表示に必須 |
| POST | `/api/v1/accounts/:id/follow` / `unfollow` | ⬜ | unfollow は Store の未実装メソッドを踏む |
| GET | `/api/v1/preferences` | ✅ | 固定値を返す |

## 投稿

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| POST | `/api/v1/statuses` | ⬜ | **最優先。`Idempotency-Key`(1時間 TTL)対応が必要** |
| GET | `/api/v1/statuses/:id` | ⬜ | |
| DELETE | `/api/v1/statuses/:id` | ⬜ | |
| GET | `/api/v1/statuses/:id/context` | ⬜ | スレッド表示に必須 |
| POST | `/api/v1/statuses/:id/favourite` / `unfavourite` | ⬜ | |
| POST | `/api/v1/statuses/:id/reblog` / `unreblog` | ⬜ | |
| POST | `/api/v1/statuses/:id/bookmark` / `unbookmark` | ⬜ | |
| POST | `/api/v2/media` | ⬜ | Cloud Storage 連携が必要 |

## タイムライン

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/timelines/public` | 🟡 | 全 Note を返す。ページネーションなし |
| GET | `/api/v1/timelines/home` | 🟡 | public と同一実装 |
| GET | `/api/v1/timelines/tag/:hashtag` | ⬜ | |
| — | ページネーション + `Link` ヘッダ | ⬜ | `max_id`/`since_id`/`min_id`/`limit`。`Access-Control-Expose-Headers: Link` も必要 |

## 通知・その他

| メソッド | パス | 状態 | 備考 |
|---|---|---|---|
| GET | `/api/v1/notifications` | ⬜ | |
| GET | `/api/v1/notifications/unread_count` | ⬜ | |
| GET | `/api/v1/markers`, POST | ⬜ | `409 Conflict` を返す楽観ロックが必要 |
| GET | `/api/v2/search` | ⬜ | |
| GET | `/api/v1/push/subscription` | ✅ | 404 を返す(Web Push 非対応) |

## 空配列スタブで足りるもの

クライアントの起動時に叩かれるが、シングルユーザー運用では中身が不要なもの。
**501 ではなく空配列 `[]` を返す。**

`/api/v1/custom_emojis`, `/api/v1/filters`, `/api/v2/filters`, `/api/v1/announcements`,
`/api/v1/lists`, `/api/v1/followed_tags`, `/api/v1/conversations`,
`/api/v1/blocks`, `/api/v1/mutes`, `/api/v1/domain_blocks`, `/api/v1/bookmarks`,
`/api/v1/favourites`, `/api/v1/follow_requests`, `/api/v1/featured_tags`

## 実装しないもの

- **ストリーミング API 全般**(→ [ADR-0007](adr/0007-no-streaming-api.md))
- **Web Push**(`POST /api/v1/push/subscription`)
- **管理 API**(`/api/v1/admin/**`)
- **複数アカウントの登録・管理**(→ [ADR-0005](adr/0005-single-user-multi-ready-data-model.md))
