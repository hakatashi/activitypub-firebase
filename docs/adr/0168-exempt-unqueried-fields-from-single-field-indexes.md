# ADR-0168: クエリに使わないフィールドを単一フィールドインデックスから除外する

- **Status:** Accepted
- **Date:** 2026-10-30

## 背景

- 本番の DB 593 MiB のうち、約 500 MiB が自動の単一フィールドインデックスだった(#424)。
  `objects` の本文・`tag`・actor の `publicKey`、`streams` に埋め込まれた `object` などが大きい。
- Firestore の除外は、フィールド名を 1 つずつ `fieldOverrides` に書くしかない。map のフィールドを除外すると、
  その下のフィールドもすべて除外される。除外は DB 全体で 200 個まで。
- firebase-tools はフィールド名をそのまま URL に入れる。`#` や `/` を含む名前(`http://ostatus.org#atomUri`、
  `https://gotosocial.org/ns#interactionPolicy` など、apex の context で圧縮されない拡張)は登録できない。

## 決定

1. `firestore.indexes.json` の `fieldOverrides` で、次のフィールドの単一フィールドインデックスをすべて無効にする。
   - `objects`:AS2・Mastodon の既知のフィールドのうち、クエリに使わないもの(`content`・`tag`・`publicKey` など)、
     `toot:*`・`as:*` の圧縮された拡張、`_meta.card`・`_meta.legacyUri`。
   - `streams`:`object`・`to`・`cc`・`likes`・`shares` など、クエリに使わないもの。
   - `deliveries`:`status` 以外のすべて。`homeFeed`・`feed`(リストのタイムライン):`id` 以外のすべて。
2. `streams` の `_meta.index` は、昇順のインデックスだけを残す。等価条件でしか引かないので降順は要らない。
3. クエリ・`orderBy` に使うフィールドは、使い方にかかわらず触らない。
   - `objects`:`type`・`_meta.published`・`_meta.attributedTo`・`_meta.inReplyTo`・`_meta.hashtags`・
     `_meta.preferredUsername`・`_meta.privateKey`。
   - `streams`:`type`・`actor`・`_meta.collection`・`_meta.mastodonId`・`_meta.actor`・`_meta.published`・`_meta.index`。
4. `#` や `/` を含む拡張フィールドは今回は除外しない。保存形式を変えて防ぐかは別の Issue(#433)で決める。
5. 新しいクエリで除外済みのフィールドを使うときは、その除外を `firestore.indexes.json` から消す。

## 理由

- 保存形式を変えて AP の JSON を 1 つのフィールドにまとめれば拡張フィールドも防げるが、apex の Store と本体の
  読み書きすべてに影響し、連合を壊すおそれが大きい。dev の 3,000 件のサンプルでは、拡張フィールドは
  `objects` の約 1 割で、大きいものは actor にしか付かない。まず名前で除外できる分を減らす。
- 複合インデックスは単一フィールドの設定と独立なので、`type + _meta.published` などのクエリは影響を受けない。
- 除外したフィールドをクエリに使うと、本番で「インデックスが必要」というエラーになる。エミュレータは
  インデックスを検査しないので、テストでは気付けない。決定 5 は、それを忘れないための規則である。

## 結果

- 本番の DB とその増え方が小さくなる。除外を設定すると、既存のインデックスはバックグラウンドで消える。
  除外したフィールドはクエリに使っていないので、消えるまでの間もクエリへの影響はない。
- 除外は 93 個(TTL の 4 個を含む)で、上限の 200 個まで余裕がある。
- 名前を列挙していない拡張フィールドのインデックスは残る。

## 参照

- 関連 Issue: #424、#433、#420
- 関連 ADR: [[0021-meta-index-as-maps]]、[[0086-normalize-object-query-fields-into-meta]]、[[0167-firestore-backup-and-pitr-per-project]]
- 外部資料: https://cloud.google.com/firestore/docs/query-data/index-overview 、https://firebase.google.com/docs/firestore/quotas#indexes
