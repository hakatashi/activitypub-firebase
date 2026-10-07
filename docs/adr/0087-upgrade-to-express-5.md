# ADR-0087: Express 5 に上げ、async ハンドラの独自ラッパーを撤去する

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Issue #214。Express 4 は async ハンドラが返した rejected Promise を捕捉しないため、
`mastodon/http/asyncRouter.ts` の `createAsyncRouter` が `get` / `post` などを差し替えてハンドラを包んでいた
([[ADR-0074]] のエラーハンドラに届けるため)。`use` / `all` は包まれておらず、新しいルーターを作るたびに
「`express.Router()` ではなく `createAsyncRouter()` を使う」という暗黙の約束が必要だった。
Express 5 はハンドラ・ミドルウェアが返した rejected Promise を `next(err)` に渡す。

## 決定

- 本体の `express` を 5 系、`@types/express` を 5 系に上げ、`createAsyncRouter` / `wrapAsyncHandler` を削除して
  `express.Router()` を直接使う。async ハンドラの例外は Express 5 にエラーハンドラへ渡させる。
- `firebase-functions`(6 系)・`@google-cloud/functions-framework`(3 系)は Express 4 系のまま据え置く。
  `onRequest(app)` に渡すのは `(req, res)` 関数であり、SDK 内部の Express とは独立している。SDK の更新は別の判断とする。
- `mastodon/index.ts` と `activitypub.ts` の app で `app.set('query parser', 'extended')` を設定する。
  Express 5 の既定 (`simple`) は `id[]=1&id[]=2` を `{ 'id[]': [...] }` と解釈し、
  Mastodon クライアントが送る配列クエリ(`accounts/relationships` など)がサイレントに壊れるため。
- `req.body` は本文がないと `undefined` になる(旧: `{}`)。zod に直接渡す箇所は `req.body ?? {}` で旧来の挙動を保つ。
- `@types/express` 5 では `req.params` の値が `string | string[]` になる(配列はワイルドカードのみ)。
  - Mastodon API のローダー(`loadStatus` / `loadAccount` など)は `unknown` を受け取り、zod で検証する。
  - apex フォークは `getRouteParam`(文字列以外は `undefined`)で読む。apex のルートは名前付きパラメーターのみ。
- 無名ワイルドカード `*` は書けないため、`/v1/streaming` と `/v1/streaming/*` は `'/v1/streaming{/*splat}'` にまとめる。
- `supertest` / `@types/supertest` は 6 系 / 2 系に据え置く。7 系の型は `onRequest` の戻り値
  (`HttpsFunction`)を受け付けず、統合テストの書き換えが必要になるため。実行時は 6 系でも Express 5 で動く。

## 結果

- 新しいルーターは `express.Router()` で作ればよく、`use` / `all` を含むすべての async ハンドラの reject が
  エラーハンドラ([[ADR-0074]])に届く。
- 新しい express app を作るときは `query parser` を `extended` にすること。
