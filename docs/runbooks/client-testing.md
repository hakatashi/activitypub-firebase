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

# (初回またはバケット作成時) Cloud Storage の CORS 設定
# Web クライアントからアバター・ヘッダー画像を読み込むために必要
gcloud storage buckets update gs://activitypub-firebase-dev.firebasestorage.app --cors-file=../../storage.cors.json
```

## 1. 実行

```bash
node run.mjs                    # 両方、閲覧のみ
node run.mjs --client elk       # 片方だけ
node run.mjs --post             # 投稿のみ行い、API で投稿が作られたことを確かめる
node run.mjs --profile          # クライアント UI からのプロフィール更新をテスト(終了後に自動復元)
node run.mjs --write            # 書き込み全般(--post と --profile のエイリアス)
node run.mjs --headed           # 画面を出して動きを見る(デスクトップで実行するとき)

# git worktree から実行するときは、メインの作業ツリーの .env を指す
ENV_FILE=~/Documents/GitHub/activitypub-firebase/.env node run.mjs
```

巡回する画面: ログイン直後、ホーム(スクロールして2ページ目を読む)、通知、自分のプロフィール、
フォロー中・フォロワー(Elk のみ)、ホームの先頭の投稿の詳細、ローカルタイムライン。

問題が1件でもあれば終了コード 1 で終わる。両クライアントで1分半ほどかかる。

## 2. 結果の読み方

標準出力に、クライアントごとの問題の一覧が出る。詳細は `tools/client-e2e/out/<client>/` にある。

- `report.json`: `failedRequests`(4xx/5xx と接続失敗)、`errors`(ページの例外とコンソールのエラー)、
  `paginated`(スクロールで `max_id` 付きのタイムライン取得が走ったか)、`post`(`--post` / `--write` の結果)、
  `profile`(`--profile` / `--write` の結果)
- `NN-<画面>.png`: 各画面のスクリーンショット。**Read で開いて目で確認する。**

確認すること:

- [ ] `failedRequests` に dev(`mastodon-dev.hakatashi.com`)への **501 / 500 がない**
- [ ] `errors` に `pageerror` がない(dev の応答の形がクライアントの想定と違うと出る)
- [ ] `paginated: true`(`Link` ヘッダが効いている)
- [ ] スクリーンショットで、タイムライン・プロフィールに中身が表示されている
  - `04-profile.png`: アバター画像・ヘッダー画像、表示名、プロフィール文が正しく描画されている
- [ ] `--post` (または `--write`) で `post: found in account statuses`
- [ ] `--profile` (または `--write`) で `profile: updated successfully via UI` (テスト終了後に元のプロフィールへ自動復元される)

## 既知の出力(2026-10-08 時点)

dev の実装が追いつけば消える。消えたらこの節も更新する。

| 出力 | 原因 |
|---|---|
| Phanpy: `GET 404 /api/v2/search?q=from:me...` と `pageerror: _a: Record not found` | 検索は未実装(Phase 4、#9)。プロフィールの投稿統計で叩く。画面は表示される |
| `GET 404 /api/v1/push/subscription`(Elk) | Web Push 未実装。購読がないときの 404 は Mastodon と同じ挙動 |
| `net::ERR_BLOCKED_BY_ORB https://img.pawoo.net/...` | キャッシュしているリモート actor のアバター URL が古い |
| Phanpy: `net::ERR_FAILED https://mastodon-test.hakatashi.com/system/...` | テスト用インスタンスのメディアの配信設定(CORS)。dev とは無関係 |
| Phanpy: `net::ERR_FAILED .../accounts/avatars/...` | GCS のエッジキャッシュ(最大1時間)に CORS 設定前の古いレスポンスが残っている場合。キャッシュ期限切れや新規画像アップロードで解消する |

## ハマりどころ

- 自宅 LAN の DNS(NAS)は `hakatashi.com` をヘアピン DNS として持っている。Firebase Hosting を指すホスト名
  (`mastodon-dev` / `activitypub-dev` など)の設定が崩れると、LAN 内でだけ名前解決が遅れたり失敗したりする。
  dev につながらない・初回だけ極端に遅いときは、まず
  `dig mastodon-dev.hakatashi.com AAAA` が即答するかを見る(構成と切り分け手順は HakataMatrix 側の `~/docs/lan-dns.md`)。
- **Cloud Storage の CORS 設定**: Web クライアント (Elk / Phanpy) が Cloud Storage の画像 (アバター・ヘッダー、添付メディア) を読み込む際、ブラウザの同一オリジンポリシーにより CORS ヘッダ (`Access-Control-Allow-Origin: *`) が必要になる。特に Phanpy はアバターの透過検出やヘッダーの背景色抽出のため `crossOrigin="anonymous"` で画像をロードする。バケットに CORS が設定されていない場合は `gcloud storage buckets update gs://<bucket> --cors-file=storage.cors.json` で設定する。
- Elk はログイン処理(`verify_credentials`)が終わる前に画面を遷移させる。
  画面遷移ではなく `verify_credentials` の応答を待つこと。
- Elk の `/` はビルド時に事前描画されており、`NUXT_PUBLIC_DEFAULT_SERVER` が効かない(既定の `m.webtoo.ls` が出る)。
  `/` 以外から入る。
- Elk が Chrome 内蔵の翻訳 API を呼んで出す `Requires a user gesture ...` は、サーバーと無関係なので除外している。
  ただし同じ原因で、**`language` が Elk の表示言語(既定は英語)と異なる投稿は、ヘッドレス Chromium では本文が描画されない**
  (`useTranslation` が `Translator.availability()` を待ったまま進まない)。スクリーンショットで本文が空の投稿があっても、
  API の `content` が正しく `language` が `ja` などなら dev の不具合ではない。
- `run.mjs` はお気に入り・ブーストのボタンを押さない。確かめるときは使い捨ての Playwright スクリプトで、投稿詳細の
  ボタン(Elk は `main` 内の `Favorite` / `Boost` ボタン、Phanpy は `.status-deck .actions` の `.favourite-button` /
  `.reblog-button`。Phanpy のブーストはメニューの `Boost` / `Unboost` まで押す)を押し、API の `favourited` / `reblogged`
  とリロード後の表示を見る。Elk のブーストで出る `Cannot read properties of null (reading 'id')` は既知
  (`docs/known-issues.md`「タイムラインにブーストが出ない」)。
- **この仕組みは OAuth の認可画面(アプリ登録 → 認可 → トークン交換)を通らない。**
  ログインまわりの変更は、従来どおりブラウザで1回ログインして確かめる。
