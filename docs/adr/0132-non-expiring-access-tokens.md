# ADR-0132: アクセストークンを無期限にする

- **Status:** Accepted
- **Date:** 2026-10-21
- **Supersedes:** [ADR-0068](0068-app-registration-oauth-revocation-and-pkce.md) の決定5のうち access token に関する部分

## 背景

アクセストークンの寿命は 24 時間で、`accessTokens.accessTokenExpiresAt` の TTL ポリシーで物理削除されていた。
本家 Mastodon のトークンは無期限で refresh token も発行せず、Elk / Phanpy も refresh token を扱わない。
そのためログインの約1日後に `access token is invalid` となり、再ログインが必要になった(#324)。

## 決定

- `saveToken` は `accessTokenExpiresAt` を Firestore に保存しない。TTL の対象から外れ、トークンは削除されない。
- `getAccessToken` は `accessTokenExpiresAt` が無いとき `9999-12-31` を補う(ライブラリが `Date` を要求するため)。
  保存されている旧トークンの期限はそのまま尊重する。
- `firestore.indexes.json` から `accessTokens.accessTokenExpiresAt` の TTL ポリシーを外す。
- `POST /oauth/revoke` による失効、認可コード・refresh token の TTL は変えない。
- `/oauth/token` の `accessTokenLifetime` はライブラリが必須とするため残す(レスポンスの `expires_in` にのみ影響)。

## 結果

- 新しく発行したトークンはログアウト(失効)まで使える。
- 既存のトークンは従来どおり TTL で消えるため、修正後に一度だけ再ログインが必要。バックフィルはしない。
