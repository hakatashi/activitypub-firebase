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
node run.mjs --media            # メディア添付の投稿をテスト
node run.mjs --delete           # 投稿の削除をテスト(削除専用の新規投稿を作成してUIから削除)
node run.mjs --interact         # お気に入り・ブーストをテスト(専用の新規投稿に対して実行)
node run.mjs --profile          # クライアント UI からのプロフィール更新をテスト(終了後に自動復元)
node run.mjs --write            # 書き込み全般(--post, --media, --delete, --interact, --profile のエイリアス)
node run.mjs --headed           # 画面を出して動きを見る(デスクトップで実行するとき)

# git worktree から実行するときは、メインの作業ツリーの .env を指す
ENV_FILE=~/Documents/GitHub/activitypub-firebase/.env node run.mjs
```

巡回する画面: ログイン直後、ホーム(スクロールして2ページ目を読む)、通知、自分のプロフィール、
フォロー中・フォロワー(Elk のみ)、ホームの先頭の投稿の詳細、ローカルタイムライン、
お気に入り・ブックマーク(どちらもスクロールして2ページ目を読む)。

問題が1件でもあれば終了コード 1 で終わる。両クライアントで1分半ほどかかる。

## 2. 結果の読み方

標準出力に、クライアントごとの問題の一覧が出る。詳細は `tools/client-e2e/out/<client>/` にある。

- `report.json`: `failedRequests`(4xx/5xx と接続失敗)、`errors`(ページの例外とコンソールのエラー)、
  `paginated`(スクロールで `max_id` 付きのタイムライン取得が走ったか)、
  `paginatedCollections`(お気に入り・ブックマークで同じく2ページ目の取得が走ったか)、`post`(`--post` / `--write` の結果)、
  `postMedia`(`--media` / `--write` の結果)、`delete`(`--delete` / `--write` の結果)、
  `interact`(`--interact` / `--write` の結果)、`profile`(`--profile` / `--write` の結果)
- `NN-<画面>.png`: 各画面のスクリーンショット。**Read で開いて目で確認する。**

確認すること:

- [ ] `failedRequests` に dev(`mastodon-dev.hakatashi.com`)への **501 / 500 がない**
- [ ] `errors` に `pageerror` がない(dev の応答の形がクライアントの想定と違うと出る)
- [ ] `paginated: true`(`Link` ヘッダが効いている)
- [ ] `paginatedCollections` の `favourites` / `bookmarks` が `true`(1ページ 20 件を超えるお気に入り・ブックマークがあるときだけ確かめられる。
  足りなければ API で `POST /api/v1/statuses/:id/favourite` / `bookmark` を足す)
- [ ] スクリーンショットで、タイムライン・プロフィールに中身が表示されている
  - `04-profile.png`: アバター画像・ヘッダー画像、表示名、プロフィール文が正しく描画されている
- [ ] `--post` (または `--write`) で `post: found in account statuses`
- [ ] `--media` (または `--write`) で `postMedia: found with media in account statuses`
- [ ] `--delete` (または `--write`) で `delete: status deleted via UI`
- [ ] `--interact` (または `--write`) で `interact: favourited and boosted via UI`
- [ ] `--profile` (または `--write`) で `profile: updated successfully via UI` (テスト終了後に元のプロフィールへ自動復元される)

## 既知の出力(2026-10-10 時点)

dev の実装が追いつけば消える。消えたらこの節も更新する。

| 出力 | 原因 |
|---|---|
| `GET 404 /api/v1/push/subscription`(Elk) | Web Push 未実装。購読がないときの 404 は Mastodon と同じ挙動 |
| `net::ERR_BLOCKED_BY_ORB https://img.pawoo.net/...`(Elk)、`GET 404` / `net::ERR_FAILED https://img.pawoo.net/...`(Phanpy) | キャッシュしているリモート actor のアバター URL が古い(#253) |
| Phanpy: `net::ERR_FAILED https://mastodon-test.hakatashi.com/system/...`、`https://s3-mstdn.maud.io/...` | リモートのメディアの配信設定(CORS)。Phanpy は `crossOrigin` 付きで画像を読む。dev とは無関係 |
| Phanpy: `net::ERR_FAILED .../accounts/avatars/...` | GCS のエッジキャッシュ(最大1時間)に CORS 設定前の古いレスポンスが残っている場合。キャッシュ期限切れや新規画像アップロードで解消する |
| Phanpy: `net::ERR_FILE_NOT_FOUND blob:http://127.0.0.1:5315/...`(`--media`) | 投稿後に Phanpy がプレビュー用の Object URL を破棄したもの。dev とは無関係 |

## 検索(`/api/v2/search`)の確認

`run.mjs` は検索を巡回しない。検索を変えたときは、Playwright で次の3つを確かめる(2026-10-09 に実施)。

- Elk の `/<dev>/search` で `@user@<リモート>` を入力し、結果からプロフィールを開いてフォローできる。
  相手は自前の `admin@mastodon-test.hakatashi.com` を使う(dev 側で一度アンフォローしてから試す)。
- Elk で `/<リモートのホスト>/@user/<ID>` を開くと、`search?q=https://...&resolve=true&limit=1` で解決されて
  `/<dev>/@user@<リモート>/<dev の ID>` に遷移し、投稿が表示される。
- 投稿欄で `@adm` と打つと、`type=accounts&resolve=true` の補完にアカウントが出る。

mastodon.social など Authorized Fetch のサーバーは署名付き GET が必要(→ [ADR-0098](../adr/0098-sign-outgoing-get-with-local-actor.md))。
相手が dev の actor の公開鍵を取りに来るため、dev がコールドスタートだと初回は 5 秒のタイムアウトで空になることがある。

## お気に入り・ブーストしたユーザー一覧(`favourited_by` / `reblogged_by`)の確認

`run.mjs` は巡回しない。変えたときは、Playwright で次を確かめる(2026-10-09 に実施)。

- 自前の `admin@mastodon-test.hakatashi.com` から自分の投稿をお気に入り・ブーストしておく
  (リモートからの Like / Announce が一覧に出ることを確かめるため)。
- Elk で投稿の詳細を開き、「…」メニューの「Show who reacted」(日本語 UI では「反応したユーザーを表示」)を押すと
  ダイアログが開く。「Favorited By」「Boosted By」の両タブにアカウントが並び、続きの `max_id` 付きの取得が 200 で
  「End of the list」になる。Elk の投稿詳細のお気に入り数・ブースト数はリンクではなく、このメニューからしか開けない。

## ハッシュタグのタイムライン(`timelines/tag`)の確認

`run.mjs` は巡回しない。変えたときは、Playwright で次を確かめる(2026-10-09 に実施)。

- API でハッシュタグ付きの公開投稿を作り、投稿の詳細を開いて本文のハッシュタグを押す。
  Elk は `/<dev>/tags/<名前>` に遷移して `tags/:name` → `timelines/tag/:hashtag` を呼び、スクロールで `max_id` 付きの取得が走る。
  Phanpy は `/#/<dev>/t/<名前>` に遷移する。Phanpy は投稿の詳細をモーダル(`.status-deck`)で開くので、
  背後のタイムラインではなくモーダルの中のリンクを押すこと。
- Elk はログイン(`verify_credentials`)の完了前に別の画面へ `goto` するとログアウト状態になり、
  タグのページがスケルトンのまま `timelines/tag` を呼ばない。ホームを開いてから進む。
- 自前の `admin@mastodon-test.hakatashi.com` からタグ付きで投稿し、dev のタグのタイムラインに出ることも確かめる
  (受信した Note の `Hashtag` は `as:Hashtag` で保存される。→ [ADR-0103](../adr/0103-hashtag-timeline-and-search.md))。

## 既定の公開範囲(`source` / `preferences`)の確認

`run.mjs` は巡回しない。変えたときは、Playwright で次を確かめる(2026-10-09 に実施)。

- **Elk には既定の公開範囲を変える設定画面がない**(`source.privacy` を読むだけ)。変更は Phanpy で行う。
  Phanpy のナビメニュー(`.nav-menu-button`)→「Settings」の `#posting-privacy-field` を変えると
  `update_credentials` が `source[privacy]` を送る。再読み込みして設定を開き直し、値が保たれていることを見る。
- Elk で投稿欄に文字を打ち、公開範囲を触らずに投稿して、`POST /api/v1/statuses` の `visibility` が
  設定した値になっていることを見る。
- 確認後は既定の公開範囲を `public` に戻す。

## Phase 4 の機能をまとめて確かめる(#231)

`run.mjs` が巡回しない、機能をまたいだ流れ。Phase 4 の機能に手を入れたときや、フェーズの終わりに行う(2026-10-10 に実施)。
相手は自前の `admin@mastodon-test.hakatashi.com` を使い、相手側の操作は `REMOTE_TOKEN` で Mastodon API を叩く
([`federation-testing.md`](federation-testing.md))。UI の操作は Playwright で、ログイン状態の作り方は `run.mjs` と同じ。

1. **検索とフォロー**: dev 側で一度アンフォローしてから、Elk の `/<dev>/search` / Phanpy の `/#/<dev>/search?q=` で
   `@admin@mastodon-test.hakatashi.com` を検索し、プロフィールの件数・登録日が相手の `verify_credentials` と一致すること、
   フォローして `relationships` が `following: true` になることを見る。相手がフォロー済みなら Elk のボタンは「Follow back」。
2. **通知**: 相手からフォロー(アンフォロー → フォロー)・メンション・お気に入り・ブーストを送り、`/api/v1/notifications` に4種類が出て、
   `unread_count` が増えることを見る。通知のページングは `limit` を小さくして `Link` の `next` を辿り、全件がちょうど1回ずつ出ることも見る。
   - **Elk の未読バッジは出ない。** Elk はストリーミングの `notification` イベントで数え、ストリーミングがないと既読化(`markers` の POST)もしない
     (`third_party/elk/app/composables/masto/notification.ts`。ストリーミングは実装しない。→ [ADR-0007](../adr/0007-no-streaming-api.md))。
   - **Phanpy の未読バッジ(`.has-badge`)は、通知画面を一度開いた後に届いた通知にだけ出る。** 最新の通知を覚えて、20 秒ごとに
     `since_id` でポーリングするため(`third_party/phanpy/src/components/background-service.jsx`)。通知画面を開く → ホームに戻る →
     相手からメンションを送る → 1 分弱待つ、の順で見る。通知画面を開くと `markers` を POST してバッジが消え、`unread_count` が 0 になる。
3. **メディア**: Elk の投稿欄で画像を2枚添付し、それぞれ「Edit」から代替テキストを入れ(`PUT /api/v1/media/:id`)、
   「Add content warning」を押して投稿する。Mastodon の `sensitive` は投稿単位で、Elk では CW と一体。
   相手の `/api/v2/search?resolve=true&q=<uri>` で `sensitive`・`media_attachments` の `description`・`blurhash` が届いていることを見る
   (相手の Web UI は未ログインだと元のサーバーへ誘導されるので、API で確かめる)。相手から `POST /api/v2/media` → 画像付きで投稿し、
   dev のホームに画像付きで出ることを見る。dev の `preferences` は `reading:expand:media: show_all` なので、dev 側のクライアントではぼかされない。
4. **返信**: dev から投稿し、相手から返信して `replies_count` が 1 になり、`context` の `descendants` に出ることを見る。
   相手の返信の詳細から Elk / Phanpy で返信し、相手の `context` に届くことを見る。
5. **お気に入り・ブースト・ブックマーク**: 相手の投稿の詳細で3つを押し、`favourites` / `bookmarks` の先頭、ホームと自分の投稿一覧の先頭のブーストに
   出ることを見る。取り消すと消える。Elk のボタンの `aria-label` は押した後に「Favorited」「Boosted」「Bookmarked」に変わる。
   Phanpy のブックマークは `.bookmark-button`、「誰が反応したか」は「…」メニューの「Boosted/Liked by…」で開く。
6. **ハッシュタグ**: 上の「ハッシュタグのタイムラインの確認」の手順。Elk のタグのページは `tags/:name` → `followed_tags` → `timelines/tag` を
   直列に待つので、表示まで 5 秒ほどかかる。
7. **プロフィール編集**: Phanpy の「Edit profile」でアバター・ヘッダーを、設定で既定の公開範囲を変える(上の「既定の公開範囲の確認」)。
   Elk のプロフィールに反映され、Elk から公開範囲を触らずに投稿すると設定した値になり、相手の `GET /api/v1/accounts/:id` の `avatar` が
   数十秒で変わることを見る。**事前に元の画像を保存しておき、確認後に `update_credentials` で戻す。**
8. **リンクプレビュー**: クローラーの UA で Elk の投稿 URL を取得し、dev の `/@hakatashi/<ID>` に 301 されて OGP が返ることを見る。

   ```bash
   curl -sL -A 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' \
     "https://elk.zone/mastodon-dev.hakatashi.com/@hakatashi/<ID>" | grep -o '<meta [^>]*og:[^>]*>'
   ```

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
- Elk が Chrome 内蔵の翻訳 API を呼んで出す `Requires a user gesture ...` と、投稿欄の言語検出(`LanguageDetector.create()`)が
  モデルのないヘッドレス Chromium で出す `Model not available` は、サーバーと無関係なので除外している。
  ただし同じ原因で、**`language` が Elk の表示言語(既定は英語)と異なる投稿は、ヘッドレス Chromium では本文が描画されない**
  (`useTranslation` が `Translator.availability()` を待ったまま進まない)。スクリーンショットで本文が空の投稿があっても、
  API の `content` が正しく `language` が `ja` などなら dev の不具合ではない。
- **お気に入り・ブースト(`--interact` / `--write`)**: Elk は `main` 内の `Favorite` / `Boost` ボタン、Phanpy は `.status-deck .actions` の `.favourite-button` / `.reblog-button`(メニューの `Boost` まで押す)を操作する。
- **メディア添付投稿(`--media` / `--write`)**: Elk では Chromium の File System Access API (`showOpenFilePicker`) が Playwright の `filechooser` イベントを発火させないため、`<input type="file">` フォールバックを利用する。Phanpy では代替テキスト未入力時の confirm ダイアログを自動承認している。
- **投稿の削除(`--delete` / `--write`)**: `--post` で投稿したステータスとは別に削除専用のステータスを作成し、UI から削除操作を行って API で 404 になることを検証する。
- **この仕組みは OAuth の認可画面(アプリ登録 → 認可 → トークン交換)を通らない。**
  ログインまわりの変更は、従来どおりブラウザで1回ログインして確かめる。
