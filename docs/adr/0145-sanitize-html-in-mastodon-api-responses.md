# ADR-0145: Mastodon API の応答で、本文・プロフィールの HTML を Mastodon の `MASTODON_STRICT` と同じ許可リストでサニタイズする

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

Issue #364。Mastodon API はリモートから受け取った Note の `content` や actor の `summary` をそのまま返している。
Phanpy はこれをサーバーがサニタイズ済みである前提で `innerHTML` に入れるため、`<img onerror>` などで XSS が起きうる。
Mastodon 本体は、リモートの HTML を保存時ではなく**描画時** (`HtmlAwareFormatter`) に `Sanitize::Config::MASTODON_STRICT` で処理する。

## 決定

1. **いつ:** 保存時ではなく、Mastodon API の presenter が Entity を組み立てるときにサニタイズする。保存する AP オブジェクトは受け取ったまま。
2. **対象:** HTML として返すフィールド、すなわち `Status.content`・`Account.note`・`Account.fields[].value`。
   ローカルの投稿・プロフィールも区別せず通す (自前の整形結果は許可リストの範囲に収まっている)。
   `spoiler_text`・`display_name`・`fields[].name` は Mastodon でもプレーンテキストなので手を加えない
   (Phanpy はテキストとして描画し、Elk は自前でサニタイズする)。
3. **許可リスト:** `MASTODON_STRICT` に揃える。
   - 要素: `p br span a del s pre blockquote code b strong u i em ul ol li ruby rt rp`。
   - 属性: 全要素に `lang`、`a` に `href rel class translate`、`span` に `class translate`、`ol` に `start reversed`、
     `li` に `value`、`p` に `class`。`class` は microformats (`h-` `p-` `u-` `dt-` `e-`)・`mention`・`hashtag`・
     `ellipsis`・`invisible`・`quote-inline` だけを残す。`translate` は `no` 以外を捨てる。
   - `a` の `rel` は `nofollow noopener` で上書きし、`target="_blank"` を付ける。`href` のスキームが Mastodon の
     `LINK_PROTOCOLS` (http, https, dat, dweb, ipfs, ipns, ssb, gopher, xmpp, magnet, gemini) 以外 (相対 URL・無しを含む) の `a` はテキストにする。
   - `h1`〜`h6` は `<p><strong>` にする。FEP-dc88 の `<math>` は TeX (`$…$` / `$$…$$`) か平文の注釈をテキストにする。
   - 許可しない要素は外して中身を残す。ただし `script style iframe math noscript svg` などは中身ごと捨て、
     `div` などのブロック要素を外したときは前後に空白を入れる (Sanitize gem の既定)。
4. **実装:** 既に依存にある parse5 で断片として解析し、木をたどって組み立て直し、parse5 で直列化する
   (`mastodon/sanitizeHtml.ts`)。リンクプレビュー用ページの `sanitizeContentHtml` ([ADR-0107](0107-minimal-html-status-page-for-link-previews.md)) は CSP で守られた別用途なので、そのままにする。

## 理由

- 応答時なら許可リストを変えたときに保存済みのデータにも効き、受信した原文を失わない。Mastodon と同じ位置でもある。
- 1 件あたり数 KB の解析で、タイムライン 40 件でも負荷は小さい。ホーム・リストの先頭ページはキャッシュ ([ADR-0139](0139-cache-timeline-head-page-in-instance.md)) される。
- 正規表現ではなく HTML パーサを使うのは、ブラウザと解釈がずれる入力 (属性内の `>`・閉じ忘れ・コメント) で抜けを作らないため。

## 結果

- リモートの投稿の `<img>`・`<div>`・`style` 属性・独自の `class` は表示されなくなる (Mastodon と同じ見え方になる)。
- `rel="tag"` などの `rel` は返らなくなる。クライアントはハッシュタグ・メンションを `class` と `tags` / `mentions` で判定する。

## 参照

- 関連 Issue: [#364](https://github.com/hakatashi/activitypub-firebase/issues/364)
- 外部資料: `third_party/mastodon/lib/sanitize_ext/sanitize_config.rb`、`third_party/mastodon/app/lib/html_aware_formatter.rb`
