# ADR-0141: 投稿本文のリンクのプレビューカードを、受信・投稿時に非同期で取得して Note の `_meta` に持つ

- **Status:** Accepted
- **Date:** 2026-10-22

## 背景

Issue #330。Status の `card` を常に `null` で返しており、Elk / Phanpy で投稿内の URL のプレビューが出ない。
クライアントは `card` を描画するだけで、OGP は各サーバーがクロールする (Mastodon の `FetchLinkCardService`)。

## 決定

1. **きっかけ:** `POST /api/v1/statuses` で投稿したとき、inbox で Note の `Create` / `Update` を受け取ったとき。
   対象の URL があるときだけ Cloud Tasks の新しい関数 `previewCardTask` に頼む (タスク ID は Note IRI + URL のハッシュ)。
   outbox の補完 ([ADR-0140](0140-backfill-remote-outbox-on-profile-view.md))・アーカイブのインポート・検索での取得では頼まない。
2. **対象の URL:** Mastodon がリモートの投稿に使う規則に揃え、本文の `<a href>` のうち最初の http(s) のリンク。
   `rel="tag"`・class が `mention` / `hashtag` / `u-url` / `h-card` のもの、`tag` の `Mention` / `Hashtag` の
   `href` と一致するもの、自ドメイン (`hakatashi.com`・Mastodon API のドメイン) のものは除く。
   添付があるか、引用 (`quoteUrl` / `quoteUri` / `_misskey_quote`) を持つ Note では作らない。
3. **取得 (SSRF 対策):** apex の `assertSafeUrl` / `makePinnedAgent` ([ADR-0050](0050-ssrf-safe-request-object-in-apex.md)) を
   リダイレクトの各ホップで使う。アドレスの範囲は apex と同じポリシー (本番は unicast のみ) で、スキームだけ
   `http` も許す。リダイレクト 5 回、タイムアウトは apex の `requestTimeout`、`200` かつ `text/html` /
   `application/xhtml+xml` のみ、本文は先頭 1MB だけ読む。署名・Cookie・`Authorization` は付けない。
4. **解析:** parse5 (依存に足す) で `<head>` を読み、`og:title` → `twitter:title` → `<title>` を題名、
   `og:description` → `description` を説明、`og:image` を画像、`og:site_name` を提供元とする。題名が無ければカードを作らない。
   文字コードは `Content-Type` → `<meta charset>` → UTF-8 の順。oEmbed と動画の埋め込み (`html`) は扱わず、`type` は常に `link`。
5. **画像:** 自前のストレージには複製せず、リモートの URL をそのまま返す。幅・高さ・blurhash を出すため、
   同じ SSRF 対策で画像を 5MB まで取得し sharp で読む (16MP 超・SVG は読まない)。読めなくても (相手の 429 など)
   画像の URL は返し、幅・高さは `og:image:width` / `height` (無ければ 0)、blurhash は null にする。
6. **保存:** URL ごとの結果を `previewCards/{URL の SHA-256}` に持ち (失敗も含む)、成功は 14 日・失敗は 1 日の間は取り直さない
   (`expiresAt` に TTL ポリシー)。Note には `_meta.card` に写しを置き、presenter は追加の読み取りなしで `card` を返す。
   写しは対象の URL を持ち、presenter は今の本文から選んだ URL と一致するときだけ返す (編集でリンクが変わったとき)。
   ローカルの投稿に写しを置いたときは、閲覧者のバージョン ([ADR-0139](0139-cache-timeline-head-page-in-instance.md)) を書き直す。
7. 処理は `social/previewCards.ts` に置く。タスクは `maxAttempts: 1` で、失敗は上記のキャッシュで翌日に任せる。
   `GET /api/v1/statuses/:id/card` は Mastodon 3.0 で削除済みなので実装しない。

## 理由

- presenter で `previewCards` を引くとタイムラインの読み取りが Status の数だけ増える。Note と一緒に読む `_meta` なら増えない。
- 画像を複製しないので、Storage の容量と削除の仕組みが要らない。閲覧者はほぼ自分 1 人で、リンク先へのアクセスと同程度の露出で済む。

## 結果

- 投稿・受信の直後はカードが無く、取得後に読み直すと出る。リモートの投稿は、ホーム・リストの先頭ページのキャッシュ
  ([ADR-0139](0139-cache-timeline-head-page-in-instance.md)) では最大 15 分遅れる。
- リンク先のページの変更は、同じ URL を含む新しい投稿が 14 日後以降に届くまで反映されない。

## 参照

- 関連 Issue: [#330](https://github.com/hakatashi/activitypub-firebase/issues/330) / [[0050-ssrf-safe-request-object-in-apex]]、[[0080-social-domain-layer-and-dependency-direction]]、[[0107-minimal-html-status-page-for-link-previews]]、[[0139-cache-timeline-head-page-in-instance]]
