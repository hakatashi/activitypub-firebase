# ADR-0151: ボットの投稿は Mastodon API で受け、1つのオペレータートークンと `X-Bot-Account` ヘッダで actor を選ぶ

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

ボットの投稿ロジックは外部のプログラムが持ち、API を呼んで投稿する(#315)。ボットはいくつでも作れ、
管理者は1人なので、1つの認証情報でどのボットからも投稿できるようにしたい。
Mastodon API の認証は トークン → uid → `userInfos` → actor の順で解決しており(`mastodon/http/auth.ts`)、
uid の UserInfo は1件であることを前提にしている。ボットの UserInfo は uid を持たない(ADR-0149)。

## 決定

1. 投稿には通常の Mastodon API を使う。`POST /api/v1/statuses`、`/api/v2/media`、
   `/api/v2/search?resolve=true` と `/api/v1/statuses/:id/reblog`、`DELETE /api/v1/statuses/:id`、
   `update_credentials` などが、そのままボットの操作になる。独自の投稿エンドポイントは作らない。
2. インスタンスごとに「オペレータートークン」を発行する。`accessTokens` に予約された uid `bot-operator` で保存し、
   無期限にする(ADR-0133)。発行は管理エンドポイント `POST /activitypub/bots/operator-token`(`adminOnly`)で行い、
   値は応答で1度だけ返す。失効は `DELETE /activitypub/bots/operator-token` で、発行済みのものをすべて消す
   (OAuth のクライアントを持たないので `POST /oauth/revoke` は使えない)。
3. `resolveAuth` は、uid が `bot-operator` で、インスタンスのボット機能が有効なとき、ヘッダ
   `X-Bot-Account: <username>` の `userInfos` を直接引く。`bot: true` でなければ(主 actor を含む)403、
   ヘッダがない・未知のときは 401 にする。それ以外のトークンの経路は変えない。
4. 通常のトークンに `X-Bot-Account` を付けても無視する(ログイン中の actor のまま)。

## 理由

- 独自のエンドポイントを作ると、メディア・リポスト・削除・Idempotency-Key などを作り直すことになる。
  Mastodon API なら既存の実装と、masto.js などのクライアントライブラリがそのまま使える(ヘッダは追加できる)。
- ボットごとにトークンを発行する案は、ボットを足すたびに外部のプログラムの設定も増える。
- `HAKATASHI_TOKEN` を Bearer として受ける案は、管理用の秘密を投稿用のプログラムにも渡すことになるので採らない。

## 結果

- 認証のキャッシュ(#358)を入れるときは、キーに `X-Bot-Account` を含める必要がある。
- オペレータートークンが漏れると、そのインスタンスのすべてのボットとして投稿できる。主 actor にはなれない。

## 参照

- 関連 ADR: [ADR-0063](0063-post-status-and-idempotency-key.md)、[ADR-0068](0068-app-registration-oauth-revocation-and-pkce.md)、[ADR-0133](0133-non-expiring-access-tokens.md)、[ADR-0149](0149-bot-actors-as-additional-local-actors.md)
