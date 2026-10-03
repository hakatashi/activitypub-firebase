# サードパーティクライアントでの動作確認

Elk / Phanpy で dev 環境(`mastodon-dev.hakatashi.com`)を開き、画面が壊れていないか、
どのエンドポイントが失敗しているかを確認する。**ブラウザを手で開かずに、エージェントのセッションから実行できる。**
なぜこの構成なのかは [ADR-0066](../adr/0066-self-hosted-clients-driven-by-playwright.md)。

> このファイルは実際に確認を行うたびに書き足していくこと。

## 原則

- **本番では試さない。** dev 環境を使う。`--write` で投稿したものは消さなくてよい。
- **クライアントの画面が出たかどうかと、API が正しいかは別。** 画面が出ていても、
  裏で 501 や例外が出ていればクライアントの機能が欠けている。必ず出力の一覧を読む。
- クライアントは自宅サーバー(HakataMatrix)で動いている。構成・更新手順は
  `~/docs/mastodon-client-test.md`(HakataMatrix 側)を参照。

| クライアント | URL | ログイン状態の作り方 |
|---|---|---|
| Elk | `http://127.0.0.1:5314` | Elk 自身の `/signin/callback?server=&token=` に遷移する |
| Phanpy | `http://127.0.0.1:5315` | localStorage の `accounts` / `currentAccount` を書く |

## 0. 準備

`.env` に `MASTODON_DEV_TOKEN` が必要(発行方法は
[`federation-testing.md`](federation-testing.md) の「dev の Mastodon API 用 OAuth アクセストークン」)。

```bash
cd tools/client-e2e
npm ci                          # 初回だけ
npx playwright install chromium # 初回と playwright の更新時だけ

# 両クライアントが起動しているか
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5314/   # Elk
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5315/   # Phanpy
```

## 1. 実行

```bash
node run.mjs                    # 両方、閲覧のみ
node run.mjs --client elk       # 片方だけ
node run.mjs --write            # 投稿も行い、API で投稿が作られたことを確かめる
node run.mjs --headed           # 画面を出して動きを見る(デスクトップで実行するとき)

# git worktree から実行するときは、メインの作業ツリーの .env を指す
ENV_FILE=~/Documents/GitHub/activitypub-firebase/.env node run.mjs
```

巡回する画面: ログイン直後、ホーム(スクロールして2ページ目を読む)、通知、自分のプロフィール、
フォロー中・フォロワー(Elk のみ)、ホームの先頭の投稿の詳細、ローカルタイムライン。

問題が1件でもあれば終了コード 1 で終わる。DNS の都合で初回は1分ほどかかる(→ 下の「ハマりどころ」)。

## 2. 結果の読み方

標準出力に、クライアントごとの問題の一覧が出る。詳細は `tools/client-e2e/out/<client>/` にある。

- `report.json`: `failedRequests`(4xx/5xx と接続失敗)、`errors`(ページの例外とコンソールのエラー)、
  `paginated`(スクロールで `max_id` 付きのタイムライン取得が走ったか)、`post`(`--write` の結果)
- `NN-<画面>.png`: 各画面のスクリーンショット。**Read で開いて目で確認する。**

確認すること:

- [ ] `failedRequests` に dev(`mastodon-dev.hakatashi.com`)への **501 / 500 がない**
- [ ] `errors` に `pageerror` がない(dev の応答の形がクライアントの想定と違うと出る)
- [ ] `paginated: true`(`Link` ヘッダが効いている)
- [ ] スクリーンショットで、タイムライン・プロフィールに中身が表示されている
- [ ] `--write` で `post: found in account statuses`

## 既知の出力(2026-10-03 時点、main)

dev の実装が追いつけば消える。消えたらこの節も更新する。

| 出力 | 原因 |
|---|---|
| `GET 501 /api/v1/followed_tags` など 501 全般 | 未実装(#63) |
| `GET 404 /api/v1/push/subscription`(Elk) | Web Push 未実装。購読がないときの 404 は Mastodon と同じ挙動 |
| Phanpy: `Cannot destructure property 'error' of 'this.serializer.deserialize(...)'` | 501 の応答本文が JSON でないため masto.js が例外を出す |
| `net::ERR_BLOCKED_BY_ORB https://img.pawoo.net/...` | キャッシュしているリモート actor のアバター URL が古い |

## ハマりどころ

- **HakataMatrix の上流 DNS(ルーター)は、Firebase Hosting のホスト名への AAAA 問い合わせに応答しない。**
  そのため名前解決に毎回15秒かかる。Node の `fetch` は名前解決込みで10秒でタイムアウトするので、
  `run.mjs` では `https` を IPv4 に固定して使っている。Chromium は初回だけ15秒待ち、その後はキャッシュが効く。
- Elk はログイン処理(`verify_credentials`)が終わる前に画面を遷移させる。
  画面遷移ではなく `verify_credentials` の応答を待つこと。
- Elk の `/` はビルド時に事前描画されており、`NUXT_PUBLIC_DEFAULT_SERVER` が効かない(既定の `m.webtoo.ls` が出る)。
  `/` 以外から入る。
- Elk が Chrome 内蔵の翻訳 API を呼んで出す `Requires a user gesture ...` は、サーバーと無関係なので除外している。
- **この仕組みは OAuth の認可画面(アプリ登録 → 認可 → トークン交換)を通らない。**
  ログインまわりの変更は、従来どおりブラウザで1回ログインして確かめる。
