# ADR-0103: ハッシュタグを `_meta.hashtags` に正規化し、タグのタイムラインと検索を引く

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

Issue #228。Note の `tag` には `Hashtag` が入っているが、`tag` は配列の中の埋め込みオブジェクトで、
Firestore からはタグ名で引けない。`timelines/tag/:hashtag`・`tags/:name`・`v2/search` の `hashtags`・
本文のリンク先 `https://<Mastodon ドメイン>/tags/<名前>` がいずれも未実装だった。

## 決定

1. **`objects` の `_meta.hashtags: string[]` に正規化したタグ名を持つ。** [[ADR-0086]] の検索用の写しの1つとして、
   `Store#saveObject` / `updateObject` が `tag` の `Hashtag` の `name` から計算し直す(部分更新では `tag` を更新するときだけ)。
   正規化は Mastodon の `HashtagNormalizer` に寄せて **NFKC → 先頭の `#` を除く → 小文字化 → 使えない文字を除く**。
   ASCII folding(`é` → `e`)はしない(日本語のタグには効かず、実装の手間に見合わない)。タグが無ければキーを持たない。
2. **クエリは `type == 'Note'` + `_meta.hashtags array-contains-any` + `_meta.published` の並べ替え。**
   `any[]` は同じ1本のクエリの `array-contains-any` に足す(合わせて 30 件まで)。`all[]` / `none[]`・`local` / `remote`・
   `only_media` は取得後にアプリ側で絞り、可視性の判定と同じく `collectVisibleNotes` の読み足しで埋める。
   複合インデックスは `type + _meta.hashtags(CONTAINS) + _meta.published`(昇順・降順)。
3. **タイムラインに出すのは公開 (`public`) の Note だけ**(`isNotePublicTimelineEligible`。Mastodon と同じ)。
   手元にあるリモートの投稿も含める。ブースト(Announce)は載せない(Mastodon も載せない)。
4. **`GET /api/v1/tags/:name` は手元に Note が無くても 200 で Tag を返す。** 名前が不正なら 404。
   Mastodon も未知のタグには `Tag.new` を返し、Elk はタグのページを開くときにこれを呼ぶ。`history` は空、`following` は false。
   `follow` / `unfollow` は実装しない(404)。
5. **`v2/search` の `hashtags` は完全一致だけ。** `q` を正規化し、その名前の公開 Note が手元に1件でもあれば Tag を1件返す。
   前方一致に要るタグの一覧(コレクション)は持たない。対象は `type` が無いか `hashtags` で、`q` に `@` を含まないとき(Mastodon と同じ)。
6. **`https://<Mastodon ドメイン>/tags/<名前>` は `mastodonApi` で Elk のタグのページへリダイレクトする。**
   Mastodon ドメインは環境ごとに違うので、`firebase.json` の静的な `redirects` ではなく rewrite + 関数にする
   (actor の URL と同じ方針、[[ADR-0004]])。
7. 既存データは `functions/bin/backfillObjectQueryMeta.ts` で埋める(写しのキーが増えるだけで、規則は同じ)。

## 結果

- タグの使用回数(`history`)・タグのフォロー・注目のタグは扱わない。
- 正規化の規則を変えたらバックフィルをやり直す必要がある。
