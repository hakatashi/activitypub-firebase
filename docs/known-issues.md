# 既知の問題

2026-09-09 時点(Phase 2 完了時)にコードを読み直して残存を確認したもの。
**推測ではなく、コードを読んで確認した事実のみを記載する。**
修正したらこのファイルから削除する(履歴は git に残る)。

## ActivityPub 仕様準拠

### inbox の side effect が限定的

apex が処理するのは `Accept` / `Announce` / `Delete` / `Like` / `Reject` / `Undo` / `Update`。
`Follow` は apex 側にケースがなく、`functions/src/activitypub.ts` の `apex-inbox` リスナーで
自前実装している。`Move` は apex が完全に非対応。

## Mastodon API

### タイムラインが全 Note を無条件に返す

`functions/src/mastodon/api.ts` の `getAllNotes()` は `type == 'Note'` の全オブジェクトを
上限なしで取得して返す。actor フィルタも公開範囲(visibility)判定もページネーションもない。
`/v1/timelines/public`、`/v1/timelines/home`、`/v1/accounts/:id/statuses` がすべてこれを呼んでいる。

→ [ADR-0005](adr/0005-single-user-multi-ready-data-model.md)

### Status ID がランダムで時系列順にならない

`noteObjectToStatus` は Note の IRI 末尾(Firestore の自動生成 ID)を Status ID に使っている。
これはランダムなので、ID の大小比較で成立している Mastodon API のページネーションが実装できない。

→ [ADR-0006](adr/0006-mastodon-api-id-scheme.md)

### 投稿できない

`POST /api/v1/statuses` が未実装。投稿は管理者トークン付きで `/activitypub/createPost` を
手動で叩くしかない。

### 未実装ルートが 501 を返す

`functions/src/mastodon/api.ts` の末尾で未定義ルートをすべて 501 にフォールバックしている。
クライアントが起動時に叩く `custom_emojis` / `filters` / `announcements` / `lists` などが
501 を返すと、クライアントが例外を投げて起動に失敗しうる。空配列を返すスタブが必要。

### Status エンティティの値が固定値

`noteObjectToStatus` は `replies_count` / `reblogs_count` / `favourites_count` を 0 固定、
`visibility` を `'public'` 固定、`language` を `'ja'` 固定、`in_reply_to_id` を `null` 固定で返す。

### instance 情報が古い/サンプルのまま

`functions/src/mastodon/instanceInformation.ts` の `version` が `'4.0.0'` で、
Mastodon 4.3.0 で追加された `api_versions` を持たない。
`contact.account.url` が `https://mastodon.social/@Gargron` のままなど、
サンプル由来の値が残っている。

### OAuth トークンを失効できない

`functions/src/mastodon/oauth2Model.ts` の `revokeToken` が未実装で、
`POST /oauth/revoke` も 501 を返す。期限切れトークンを掃除する仕組みもない。

## その他

### actor ルートにハンドラが二重登録されている

`functions/src/activitypub.ts:100` と `:119` で、同じ `routes.actor` に apex のハンドラと
Elk へのリダイレクトハンドラを続けて登録している。apex が `next()` を呼ばないため
後者は到達しない。ブラウザからのアクセスを Elk に飛ばす意図と思われるが機能していない。

