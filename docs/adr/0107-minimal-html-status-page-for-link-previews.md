# ADR-0107: リンクプレビュー用に、投稿とプロフィールの最小限の HTML を Mastodon ドメインで返す

- **Status:** Accepted
- **Date:** 2026-10-10

## 背景

Issue #163。Elk はクローラー (`Discordbot` など) からのアクセスに OGP を返さず、
`https://elk.zone/<server>/@<acct>/<id>` を `https://<server>/@<acct>/<id>` へ 301 する。
本物の Mastodon はこのパスで OGP 付きの HTML を返すが、このプロジェクトでは 404 になり、
Discord / Slack に Elk の URL を貼ってもプレビューが出ない。
自前の Web UI は作らない方針である ([ADR-0004](0004-no-custom-ui-use-elk.md))。

## 決定

1. **人間向けの UI はスコープ外のままとし、Bot 向けの最小限の HTML だけを返す。**
   タイムラインや操作ボタンは作らない。人間が開いても読める程度のインライン CSS だけを付け、
   JavaScript が動く環境 (Elk のクローラー判定に当たらない UA) では Elk の同じページへ `location.replace` する。
2. **Mastodon ドメイン (`mastodonApi`) の `/@:acct/:id` (投稿) と `/@:acct` (プロフィール) で返す。**
   `:acct` は `hakatashi` と `hakatashi@<AP ドメイン>` の両方を受け付ける (Elk は後者を使う)。
   AP ドメインは個人サイトと共用なので使わない ([ADR-0008](0008-two-domain-split.md))。
3. **ローカル actor の `public` / `unlisted` の Note だけを返し、それ以外 (他人の acct、存在しない ID、
   `private` / `direct`、Tombstone、ブースト) はすべて同じ 404 にする。** 存在を明かさない。
4. **ローカルの Note の Status の `url` を `https://<Mastodon ドメイン>/@hakatashi/<Mastodon ID>` にする。**
   Mastodon と同じ形で、Elk の「リンクをコピー」などで共有した URL もプレビューが出る。
   AP の Note の `url` と IRI は変えず、IRI での content negotiation もしない (連合への影響を避ける)。
5. OGP は Mastodon の `statuses/show` に倣う。`og:description` は CW があれば CW、無ければ本文のプレーンテキスト。
   `og:image` は sensitive でない画像の添付があれば先頭のもの (`summary_large_image`)、無ければアバター (`summary`)。
6. 本文 HTML は許可リスト (`p` / `br` / `a` / `span` と一部の属性、`http(s)` の `href` のみ) でサニタイズしてから埋め込み、
   属性値はすべてエスケープする。`Content-Security-Policy` は `default-src 'none'` とし、
   インラインの `<style>` と `<script>` はハッシュで許可する。スクリプトは固定文字列にしてハッシュを一定に保つ。
7. `Cache-Control` は 200 で `public, max-age=60, s-maxage=300`、404 で `no-store`。削除した投稿は CDN に最大 5 分残る。

## 理由

- 本物の Mastodon と同じパスで返せば、Elk のリダイレクトをそのまま受けられ、他のクライアントのリンクにも効く。
- JS でのリダイレクト判定を UA の正規表現でクライアント側に置くので、レスポンスが UA に依存せず
  `Vary: User-Agent` なしで CDN に載せられる。JS を実行するクローラーと Elk の間でのリダイレクトの往復も防げる。

## 結果

- AP の IRI (`/activitypub/o/...`) をブラウザで開くと引き続き 404 になる。
- リモートの投稿・アカウントのページは返さない。

## 参照

- [[0004-no-custom-ui-use-elk]]、[[0006-mastodon-api-id-scheme]]、[[0008-two-domain-split]]
- `third_party/mastodon/app/views/statuses/show.html.haml`、`_og_description.html.haml`、`_og_image.html.haml`
- 関連 Issue: [#163](https://github.com/hakatashi/activitypub-firebase/issues/163)
