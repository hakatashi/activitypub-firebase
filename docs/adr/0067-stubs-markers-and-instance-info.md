# ADR-0067: クライアント起動用スタブ・既読マーカー・インスタンス情報の整備

- **Status:** Accepted
- **Date:** 2026-10-04

## 背景

Elk 等の Mastodon クライアント起動時、未実装エンドポイントへの 501 応答や
ストリーミング接続失敗、サンプル情報の混入によってクライアントが例外を投げたり
誤った動作をする。また actor URL へのブラウザアクセスが Elk へリダイレクトされない。

## 決定

1. **未定義ルートは 404 を返す。** 未実装の Mastodon エンドポイント
   (`custom_emojis`, `filters`, `announcements`, `lists`, `followed_tags`,
   `conversations`, `blocks`, `mutes`, `domain_blocks`, `bookmarks`, `favourites`,
   `follow_requests`, `featured_tags`) は空配列 `[]` のスタブを提供する。
2. **ストリーミングは提供せず 404 を返す。** `/api/v2/instance` の
   `urls.streaming` および `/api/v1/instance` の `urls.streaming_api` は空文字にする。
3. **既読位置マーカー (`/api/v1/markers`) を実装する。** Firestore の `markers`
   コレクションで管理し、`version` カラムによる楽観的ロックで競合時は 409 を返す。
4. **インスタンス情報を Mastodon 4.3.0 互換に更新する。** `api_versions` を追加し、
   `contact.account` や `stats` は実データ (`UserInfos`) と整合させる。
5. **actor URL は Content Negotiation を行う。** `text/html` を優先する
   リクエストは Elk へリダイレクトし、それ以外は apex ハンドラへ渡す。

## 理由

Mastodon API では未定義ルートは 404 が標準的であり、501 だとクライアントの
例外処理を誘発する。空配列スタブによりクライアントの初期化処理を安全に通す。
マーカー API はタイムラインの同期と未読バッジに必須である。

## 結果

- Elk や Phanpy などのクライアントが正常に起動・初期化できるようになる。
- タイムラインと通知の既読位置が保持される。
- ブラウザで actor URL を開いた際に Elk のプロフィールへ遷移する。

## 参照

- [[ADR-0004]] 自前 Web UI を作らず Mastodon 互換 API + Elk を使う
- [[ADR-0007]] ストリーミング API は実装しない
- Issue #63
