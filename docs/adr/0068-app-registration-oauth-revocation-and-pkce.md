# ADR-0068: アプリ登録の配列対応・トランザクション採番・OAuth トークン失効と PKCE

- **Status:** Accepted
- **Date:** 2026-10-04

## 背景

`POST /api/v1/apps` で `redirect_uris` の配列形式に対応しておらず、アプリ ID の採番が競合し得た。
また `GET /api/v1/apps/verify_credentials` が未実装で、OAuth の refresh token grant で要求される
`revokeToken` やログアウト用 `POST /oauth/revoke` も未実装だった。
さらに PKCE の `code_challenge` / `state` が認可画面のフォームを経由する際に欠落していた。

## 決定

1. **`POST /api/v1/apps` は文字列・配列の両形式を受け付ける。**
   Firestore には `redirectUris` を配列として正規化して保存し、レスポンスには deprecated な
   `redirect_uri` (改行区切りまたは単一 URI) と `redirect_uris` (配列) の両方を返す。
2. **アプリ ID は Firestore トランザクション内で採番する。**
   `mastodon/index.ts` の `beforeUserCreate` と同様に `Clients.count()` をトランザクション内で
   取得して `count + 1` を文字列として振る。
3. **`GET /api/v1/apps/verify_credentials` を実装する。**
   Bearer トークンで認証し、`client_id` / `client_secret` などの秘密情報を除外した
   アプリケーション情報を返す。
4. **OAuth モデルに `getRefreshToken` と `revokeToken` を実装する。**
   `refresh_token` grant によるローテーション失効と、`POST /oauth/revoke` (RFC 7009) での
   トークン失効を可能にする。所有者検証を行い、他クライアントのトークン失効要求には 403 を返す。
   存在しないトークンの失効は 200 `{}` を返す (冪等性)。
5. **期限切れトークン・認可コードの物理削除は Firestore TTL ポリシーに任せる。**
   `authorizationCodes.expiresAt`、`accessTokens.accessTokenExpiresAt`、
   `refreshTokens.refreshTokenExpiresAt` を `firestore.indexes.json` の `fieldOverrides` に設定する。
6. **認可画面 (GET / POST `/oauth/authorize`) で PKCE と state を引き回す。**
   `code_challenge`、`code_challenge_method`、`state` をクエリから受け取り、承認フォームの
   hidden フィールドとして POST 先へ渡すことで、`oauth2-server` 側の PKCE 検証を完結させる。

## 理由

- Mastodon 4.3+ の仕様および RFC 7009 / RFC 7636 に準拠し、サードパーティ製クライアントの
  登録・認証・失効フローを正常に動作させるため。

## 結果

- 配列形式の `redirect_uris` や PKCE を要求する OAuth クライアントが正しく動作する。
- リフレッシュトークンによる更新やログアウト時のトークン失効が安全に行われる。

## 参照

- 関連 ADR: [[ADR-0004]]、[[ADR-0063]]
- Issue #64
