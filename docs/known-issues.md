# 既知の問題

2026-10-01 時点(Phase 2.5 完了時)にコードを読み直して残存を確認したもの。
**推測ではなく、コードを読んで確認した事実のみを記載する。**
修正したらこのファイルから削除する(履歴は git に残る)。

## ActivityPub 仕様準拠

### inbox の side effect が限定的

apex が処理するのは `Accept` / `Announce` / `Delete` / `Like` / `Reject` / `Undo` / `Update`。
`Follow` は apex 側にケースがなく、`functions/src/activitypub.ts` の `apex-inbox` リスナーで
自前実装している。`Move` は apex が完全に非対応。

## Mastodon API

### 投稿本文のメンション・リンクを解析しない

`POST /api/v1/statuses` は本文をエスケープして段落に分けるだけで、URL・`@メンション`・
`#ハッシュタグ` をリンクにせず、`tag` も付けない。メンションした相手は宛先に入らないため、
リプライでない `direct` 投稿は誰にも配送されない(→ [ADR-0063](adr/0063-post-status-and-idempotency-key.md))。

### 未実装ルートが 501 を返す

`functions/src/mastodon/api.ts` の末尾で未定義ルートをすべて 501 にフォールバックしている。
クライアントが起動時に叩く `custom_emojis` / `filters` / `announcements` / `lists` などが
501 を返すと、クライアントが例外を投げて起動に失敗しうる。空配列を返すスタブが必要。

### instance 情報が古い/サンプルのまま

`functions/src/mastodon/instanceInformation.ts` の `version` が `'4.0.0'` で、
Mastodon 4.3.0 で追加された `api_versions` を持たない。
`contact.account.url` が `https://mastodon.social/@Gargron` のままなど、
サンプル由来の値が残っている。

### OAuth トークンを失効できない

`functions/src/mastodon/oauth2Model.ts` の `revokeToken` が未実装で、
`POST /oauth/revoke` も 501 を返す。期限切れトークンを掃除する仕組みもない。
