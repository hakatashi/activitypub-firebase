# ADR-0004: 自前 Web UI を作らず Mastodon 互換 API + Elk を使う

- **Status:** Accepted
- **Date:** 2026-09-03(2023-07 の実装時点の判断を事後的に記録したもの)

## 背景

ActivityPub サーバーを日常的に使うには、投稿・タイムライン閲覧・通知確認などができる UI が要る。
自前で Web UI を書くと実装量がサーバー本体を上回りかねず、また `hakatashi.com` は既に個人サイトとして
静的コンテンツが置かれている。

## 決定

**自前の Web UI を実装しない。** 代わりに Mastodon 互換の REST API を提供し、
既存の Mastodon Web クライアント **Elk**(`elk.zone`)をそのままフロントエンドとして使う。

認証は独自の OAuth2 サーバー(`@node-oauth/oauth2-server`)を立て、その認可画面の中で
Firebase Authentication(Google ログイン)を使って本人確認する。actor ページへのブラウザからの
アクセスは Elk へリダイレクトする。

## 理由

Mastodon 互換 API を実装すれば Elk 以外のサードパーティクライアント(iOS/Android アプリ含む)も
そのまま使えるため、UI を1つ書くより投資効率が良い。これは本プロジェクトの目的の1つでもある。

Firebase Authentication を OAuth2 の `authenticateHandler` の内側に閉じ込めることで、
パスワード管理を自前で持たずに済む。

## 結果

- **Mastodon API の互換性が UI の品質に直結する。** クライアントが起動時に叩くエンドポイント
  (`/api/v2/instance`, `/api/v1/accounts/verify_credentials` など)が壊れていると何も表示されない。
  未実装エンドポイントは 501 ではなく空配列を返すスタブを置く必要がある。
- Mastodon が API を変更・非推奨化した場合、追随する責任が生じる。
- Elk はブラウザで動くため、ページネーションの `Link` ヘッダを読ませるには
  `Access-Control-Expose-Headers: Link` が必要になる。
- ストリーミング API を提供しないため、クライアントはポーリングにフォールバックする
  (→ [ADR-0007](0007-no-streaming-api.md))。

## 参照

- [[ADR-0007]] ストリーミング API は実装しない
- [[ADR-0008]] ActivityPub と Mastodon API を2つのドメインに分ける
- `functions/src/mastodon/oauth.ts`(Firebase Auth を埋め込んだ OAuth2 認可画面)
- [`docs/mastodon-api-coverage.md`](../mastodon-api-coverage.md)
