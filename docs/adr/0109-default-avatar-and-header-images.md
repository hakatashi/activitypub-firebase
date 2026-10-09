# ADR-0109: 画像のない Account の `avatar` / `header` に、Mastodon ドメインから配信する既定画像の URL を返す

- **Status:** Accepted
- **Date:** 2026-10-10

## 背景

Issue #252。`icon` / `image` を持たない actor の Account で `avatar` / `header` (と `_static`) が空文字列になり、
Elk はこれを `<img src>` に入れるので、ヘッダーのないアカウントのプロフィールで壊れた画像が出る。
Mastodon は画像がないときも `/avatars/original/missing.png` / `/headers/original/missing.png` の
URL を返し (`REST::AccountSerializer` の `default_url`)、クライアントは常に URL が入っている前提で描画する。

Hosting の `public/` は個人サイト hakatashi.com の submodule で、Mastodon ドメインの Hosting とも共用している
([ADR-0008](0008-two-domain-split.md))。ここへファイルを置くには個人サイト側を変える必要がある。

## 決定

1. **既定画像は `mastodonApi` が Mastodon と同じパス `/avatars/original/missing.png` と
   `/headers/original/missing.png` で返す。** Hosting の rewrite でこの 2 パスを `mastodonApi` へ送る。
   `public/` には何も置かない。
2. **画像は自前で作った 1×1 の PNG をソースに埋め込む。** アバターは単色 (`#9baec8`)、ヘッダーは透明。
   クライアントは枠いっぱいに拡大するので 1×1 で足りる。Mastodon の `missing.png` は AGPL なので使わない。
3. `Cache-Control` は `public, max-age=86400, s-maxage=86400`。内容は固定なので CDN に載せる。
4. Account の `avatar` / `avatar_static` / `header` / `header_static` は、actor の `icon` / `image` の URL が
   空でない文字列でなければ既定画像の URL (`https://<Mastodon ドメイン>/...`) にする。ローカル・リモートとも同じ。

## 理由

- Elk は `header` が `/original/missing.png` で終わるかで「ヘッダーなし」を判定し、そのときヘッダー画像を描画しない
  (`third_party/elk/app/components/account/AccountHeader.vue`)。Mastodon と同じパスにすればこの判定がそのまま効く。
- 画像は固定の数十バイトで、Function のコールドスタート以外にコストはなく、CDN のキャッシュでほぼ Function を起動しない。

## 結果

- AP の actor (`icon` / `image`) は変えない。既定画像は Mastodon API の表現だけの話で、連合には出さない。
- リンクプレビューの HTML ([ADR-0107](0107-minimal-html-status-page-for-link-previews.md)) はアバターがなければ
  引き続き画像を出さない。

## 参照

- [[0008-two-domain-split]]、[[0107-minimal-html-status-page-for-link-previews]]
- `third_party/mastodon/app/serializers/rest/account_serializer.rb`、`app/models/concerns/account/avatar.rb`
- 関連 Issue: [#252](https://github.com/hakatashi/activitypub-firebase/issues/252)
