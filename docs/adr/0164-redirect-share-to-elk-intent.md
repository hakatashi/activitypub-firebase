# ADR-0164: `/share` を Elk の `/intent/post` へリダイレクトする

- **Status:** Accepted
- **Date:** 2026-10-26

## 背景

Mastodon 本家は `/share?text=<text>` で投稿画面を開く(Twitter の Intent に相当)。
ブックマークレットや「Mastodon で共有」ボタンはこれを前提にしている。
自前の Web UI は持たず Elk を使う(→ ADR-0004)ため、`mastodon.hakatashi.com/share` は 404 になる。
Elk には `/intent/post` があり、`text` を受けて投稿ダイアログを開く
(`third_party/elk/app/pages/intent/post.vue`)。Phanpy にはクエリで投稿画面を開く仕組みがない。

## 決定

`GET /share` を `https://elk.zone/intent/post?text=<text>` へ 302 でリダイレクトする。
`text` のみ引き継ぐ(Mastodon 本家の `/share` が受け取るのも `text` のみ)。
実装は `/tags/:name` と同じく `mastodonApi` の Express ルートにする(→ ADR-0103)。

## 理由

- 宛先ホストは `/tags/:name` やアカウント URL と同じく `elk.zone` に揃える。
- `firebase.json` の `redirects` ではなくルートにしたのは、クエリ文字列の引き継ぎを
  Firebase Hosting の挙動に頼らず、テストで保証するため。
- 302 にしたのは、宛先(自前ホストの Elk など)を後で変えられるようにするため。

## 結果

- `/share` から Elk の投稿ダイアログが開く。ただし `elk.zone` 側でこのインスタンスにログイン済みであること。
  Elk の intent ページは未ログイン時の処理を持たない(ソースに `TODO: login check`)。
- `firebase.json` の `mastodon` ターゲットに `/share` の rewrite が要る。

## 参照

- 関連 ADR: [ADR-0004](0004-no-custom-ui-use-elk.md)、[ADR-0103](0103-hashtag-timeline-and-search.md)
- 関連コード: `functions/src/mastodon/index.ts`
