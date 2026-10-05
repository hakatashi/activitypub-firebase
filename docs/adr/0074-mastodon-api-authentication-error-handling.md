# ADR-0074: Mastodon API の認証エラーハンドリングと統一的なエラー応答

- **Status:** Accepted
- **Date:** 2026-10-06

## 背景

認証が必要な Mastodon API において、未認証や無効トークンでのアクセス時に
401 ではなく 500 Internal Server Error が返ることがあった(Issue #157)。
Express 4 では非同期ハンドラの reject が自動で捕捉されず、また
`authRequired` や `resolveAuth` 内での例外・`assert` が適切に分類されていなかった。
Elk などのクライアントは 401 を受けてログアウト処理を行うため、500 だと復旧できない。

## 決定

1. **`authRequired` で認証エラーを捕捉し 401 を返す。**
   `oauth.authenticate()` が投げる OAuthError (未指定・無効・期限切れ) を捕捉し、
   401 と `{ "error": error.message }` を返す。OAuth レスポンスヘッダ
   (`WWW-Authenticate`) も Express レスポンスに反映する。
2. **トークンに対応するユーザーが存在しない場合は 401 を返す。**
   `token.user?.userId` がない、または `UserInfos` に対応ユーザーが存在しない場合は
   `assert` で落とさず 401 `{ "error": "This method requires an authenticated user" }` を返す。
3. **認証エラー以外の例外は 401 に握りつぶさず 500 にする。**
   DB 通信障害などの想定外エラーは 401 ではなく 500 とする。
   API ルーター末尾に JSON エラーハンドリングミドルウェアを設置し、
   予期しない例外は `{ "error": "Internal server error" }` を返す。

## 理由

Mastodon API 仕様に準拠し、クライアントが認証失効を正しく検知できるようにする。
また内部アサーションエラーの漏洩を防ぎ、認証失敗とシステム障害を明確に区別する。

## 結果

- Elk などのクライアントでトークン失効時のログアウト・再認証が正常に機能する。
- 未認証・無効トークン・ユーザー不在トークンに対する 401 応答が統合テストで保証される。

## 参照

- Issue #157
- [[ADR-0004]] 自前 Web UI を作らず Mastodon 互換 API + Elk を使う
