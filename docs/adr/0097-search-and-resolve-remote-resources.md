# ADR-0097: `search` でアカウントを検索し、`resolve=true` でリモートのアカウント・投稿を解決する

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

`GET /api/v2/search` が未実装で、Elk / Phanpy から手元にないリモートアカウントのフォローや、
他サーバーの投稿 URL を開くこと(permalink)ができない。[[0073-lookup-cached-remote-accounts]] は
「リモートの解決は `search?resolve=true` の役割」としている (Issue #227)。

## 決定

1. **`q` の解釈**(Mastodon の `SearchService` / `ResolveURLService` / `AccountSearchService` にならう)。
   - `http(s)://` の URL: 手元の `objects` を IRI で引く。Mastodon 形式の HTML 用 URL(`/@user/123`)は
     `/users/user/statuses/123` と推定して引く(`url` は配列にもなるため検索しない。[[0086-normalize-object-query-fields-into-meta]])。
     無く `resolve=true` なら取得し、actor ならアカウント、Note なら投稿として返す。
     自ドメインの URL(Mastodon ドメインの `/@user/<ID>` を含む)は取得せず手元からのみ引く。
   - `@user@domain` / `user@domain`: acct として手元から引き、無く `resolve=true` なら WebFinger で解決する。
   - それ以外: 手元の actor の `_meta.preferredUsername` の前方一致(範囲クエリ)。大文字小文字は区別する。
     表示名の部分一致は Firestore でできないので行わない。
2. **投稿の全文検索はしない。** Firestore に全文検索がなく、外部の検索サービスは運用費用を増やすため。
   URL 以外の `q` で `statuses` は常に空。`hashtags` は #228 で実装するまで空。
3. **`resolve=true` と `offset` は認証済みのときだけ。** 未認証なら Mastodon と同じく 401 を返す。
   `GET /api/v1/accounts/search` は Mastodon と同じく認証必須。
4. **外部取得の上限。** 1回の検索で WebFinger 1本 + AP オブジェクトの取得最大3本
   (URL・`id` が別オリジンのときの `id` での取り直し・Note の投稿者)。各取得は apex の
   SSRF ガードとタイムアウト(5秒)に従う。失敗はすべて空の結果にし、500 にしない。
5. **取得したオブジェクトのオリジン検証。** 取得結果の `id` が要求 URL と別オリジンなら `id` で取り直し、
   取り直した結果の `id` が一致するものだけを受け入れる(Mastodon の `FetchResourceService` と同じ)。
   自ドメインの `id` を名乗るものと、投稿者のオリジンが Note と異なるものは捨てる。
6. 解決した Note は投稿者の actor も `objects` に入れ、`isNoteVisibleTo` で見えないものは返さない。
   ロジックは `functions/src/social/search.ts` に置く([[0080-social-domain-layer-and-dependency-direction]])。

## 結果

- Elk の permalink とメンション補完、未フォローのリモートアカウントのフォローができる。
- HTML 用の URL に `Accept: application/activity+json` で AP JSON を返さないサーバーの投稿は解決できない。
