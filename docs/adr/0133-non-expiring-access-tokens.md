# ADR-0133: アクセストークンを無期限にする

- **Status:** Accepted
- **Date:** 2026-10-21
- **Supersedes:** [ADR-0068](0068-app-registration-oauth-revocation-and-pkce.md) の決定5のうち access token に関する部分

## 背景

アクセストークンの寿命は 24 時間で、`accessTokens.accessTokenExpiresAt` の TTL ポリシーで物理削除されていた。
本家 Mastodon のトークンは無期限で refresh token も発行せず、Elk / Phanpy も refresh token を扱わない。
そのためログインの約1日後に `access token is invalid` となり、再ログインが必要になった(#324)。

## 決定

- `saveToken` は `accessTokenExpiresAt` に `9999-12-31` を保存する。oauth2-server の `Token` が
  `Date` の `accessTokenExpiresAt` を要求するため、実データも実際の挙動(無期限)と一致させる。
  TTL ポリシーは外すので、この値でもドキュメントは削除されない。
- `getAccessToken` は保存されている期限をそのまま返す(欠けている場合のみ同じ日付を補う)。
- `firestore.indexes.json` から `accessTokens.accessTokenExpiresAt` の TTL ポリシーを外す。
- `POST /oauth/revoke` による失効、認可コード・refresh token の TTL は変えない。
- `/oauth/token` の `accessTokenLifetime` はライブラリが必須とするため残す(レスポンスの `expires_in` にのみ影響)。

## 結果

- 新しく発行したトークンはログアウト(失効)まで使える。
- 既存のトークンは従来どおり TTL で消えるため、修正後に一度だけ再ログインが必要。バックフィルはしない。
