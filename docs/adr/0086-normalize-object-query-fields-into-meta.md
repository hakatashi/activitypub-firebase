# ADR-0086: objects の検索用フィールドを `_meta` に正規化し、OR クエリをなくす

- **Status:** Accepted
- **Date:** 2026-10-07
- **Supersedes:** [[ADR-0072]]

## 背景

Issue #196。apex が受信したオブジェクトは `compactArrays: false` で配列になり、ローカルで作ったものはスカラーのままなので、
`getNotes`(`attributedTo`)・`getReplies`(`inReplyTo`)・acct lookup(`preferredUsername`)が `==`/`in` と
`array-contains(-any)` の OR になっていた([[ADR-0064]]、[[ADR-0072]])。`getNotes` は選言数が2倍になるため、
1回に渡せる actor が 15 件(`NOTE_AUTHORS_QUERY_LIMIT`)に制限されていた。

## 決定

- `Store#saveObject` / `updateObject` が `_meta.attributedTo` / `_meta.inReplyTo` / `_meta.preferredUsername` を書く。
  値は**先頭の1件の文字列**(IRI は `toIdArray`、`preferredUsername` は `toStringValue`)。解決できなければキーを持たない。
  Note の作者・返信先は1件の前提で、取得後の判定(`getAttributedTo`、スレッドの走査)も先頭しか見ていないため、map 形式にはしない。
- 写しは保存する内容から毎回計算し直し、既存の値を引き継がない(`saveObject` / `fullReplace`)。
  部分更新では、更新するフィールドに対応するキーだけを書き直す(`null` なら削除)。
- クエリは写しへの等価条件だけで書く。`getNotes` の actor は `FIRESTORE_IN_QUERY_LIMIT`(30)で分割し、
  `NOTE_AUTHORS_QUERY_LIMIT` は撤去する。
- AP オブジェクト自体は書き換えない([[ADR-0062]] と同じ流儀)。`saveObject` が `inReplyTo` を配列に寄せていた処理は撤去する。
  また `saveObject` は渡されたオブジェクトを書き換えない(apex は Create に埋め込んだオブジェクトをそのまま渡すため)。
- 複合インデックスは `type + _meta.attributedTo + _meta.published`(昇順・降順)と
  `type + _meta.inReplyTo + _meta.published`(昇順)に置き換え、`attributedTo` / `inReplyTo` / `published` を含むものは削除する。
- 既存データは `functions/bin/backfillObjectQueryMeta.ts` で埋める。デプロイ後バックフィル前は、
  既存の Note がタイムライン・スレッドから、既存の actor が lookup から漏れる。
  本 Issue は1つの PR にまとめ、マージ直後に本番でバックフィルを実行する。

## 他のフィールドの調査

- `type`: JSON-LD の `@type` は単一値なら `compactArrays: false` でもスカラーのまま
  (Mastodon など主要実装は単一値)。`where('type', '==', ...)` はそのまま使う。複数型のオブジェクトは対象外のまま。
- `_meta.privateKey` / `_meta.published`: Store が書く値で、形は揃っている。
- `streams` の `actor` / `object` は apex が常に配列で保存し、`_meta.index`([[ADR-0021]])で引ける。本 ADR の対象外。

## 結果

- `functions/src` から `objects` に対する OR クエリがなくなり、ホームタイムラインのクエリ回数が半分になる。
- `objects` のフィールドで絞り込むクエリを新たに書くときは、生のフィールドではなく `_meta` の写しを使う。
