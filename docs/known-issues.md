# 既知の問題

2026-10-05 時点(Phase 3 完了時)にコードを読み直して残存を確認したもの。
**推測ではなく、コードを読んで確認した事実のみを記載する。**
修正したらこのファイルから削除する(履歴は git に残る)。

## ActivityPub 仕様準拠

### inbox の side effect が限定的

apex が処理するのは `Accept` / `Announce` / `Delete` / `Like` / `Reject` / `Undo` / `Update`。
`Follow` は apex 側にケースがなく、`functions/src/activitypub.ts` の `apex-inbox` リスナーで
自前実装している。`Move` は apex が完全に非対応。

## Mastodon API

### 期限切れの OAuth トークンが残り続ける

`POST /oauth/revoke` による失効には対応しているが、期限切れのアクセストークン・
リフレッシュトークン・認可コードを `functions/src/mastodon/oauth2Model.ts` の外から掃除する仕組みがない。

### タイムラインにブーストが出ない

`noteObjectToStatus`(`functions/src/mastodon/api.ts`)は `reblog` を常に `null` で返し、
タイムラインと `accounts/:id/statuses` は Note だけを集める。自分やフォロー中のアカウントの
`Announce` はタイムラインに現れない(ブーストの実行と `reblogged` の判定はできる)。

### リモートアカウントのカウントと登録日が固定値

リモートアカウントの Account は `externalUserInfo` を下敷きにしており、`followers_count` /
`following_count` / `statuses_count` は 0、`created_at` は `2021-01-01` 固定
(→ [ADR-0075](adr/0075-recompute-follow-counts.md) の「未対応」)。

### ブックマーク・お気に入り一覧が空

`POST /api/v1/statuses/:id/bookmark` は `userInfos/{actor}/bookmarks` に保存するが、
`GET /api/v1/bookmarks` / `GET /api/v1/favourites` は空配列のスタブのまま。

### ハッシュタグのリンク先が 404

投稿本文のハッシュタグは `https://<Mastodon ドメイン>/tags/<名前>` にリンクするが、
そのページもハッシュタグタイムライン(`/api/v1/timelines/tag/:hashtag`)も未実装。

## テスト

### `mastodon-post-status.spec.ts` が CI でタイムアウトすることがある

`sanitizes dangerous URL scheme in resolved mention before saving post` が CI 上で既定の 10 秒を超えて
落ちたことがある(main の Deploy、2026-10-05)。直後の main の実行では通っている。
