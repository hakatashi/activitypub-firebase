# ADR-0146: outbox などのコレクションは、アクティビティの Mastodon ID の降順で並べる

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

Issue #359。AP 仕様 §5 は `OrderedCollection` を常に新しい順に示すことを求める (MUST)。
`getStream` は `streams` のドキュメント ID (アクティビティの IRI) の降順で並べていたが、IRI の末尾は
Firestore の自動 ID (ランダム) なので時系列と無関係だった。outbox・inbox・followers・following・liked・likes・shares のすべてが影響を受ける。

## 決定

1. **並べ替えのキー:** アクティビティの Mastodon ID (→ ADR-0058) を `_meta.mastodonId` に持ち、その降順で並べる。
   - `saveActivity` は新規・既存を問わず同じトランザクションで Mastodon ID を引く (採番する) ので、追加の読み取りは要らない。
   - `published` を基準に、未来は現在時刻に丸め、欠損なら保存時刻で採番されるため、受信した Follow など `published` のないものも時系列に収まる。
   - IRI ごとに一意なので、カーソルに同値が生じない。`_meta.published` (Announce にしかない、→ ADR-0062) や受信時刻を新たに持つ案はこの点で劣る。
2. **書き込み:** `saveActivity` が新規作成と、既存のアクティビティを新しいコレクションに足すときに書く。
   `updateActivity` の置き換えは既存の `_meta` を引き継ぐ (→ ADR-0053)。
3. **カーソル:** apex の `buildCollectionPage` に渡す `_id` を Mastodon ID にする (`?page=<Mastodon ID>`)。
   以前のドキュメント ID のカーソルが来たら、そのドキュメントの `_meta.mastodonId` を読んで続きを返す
   (外部のサーバーが辿っている途中のページを壊さない)。見つからなければ空のページを返す。
4. **全件取得 (`limit === null`):** 配送先の解決 (`getFollowers(actor, Infinity)`) などで使う。
   新しいインデックスもバックフィルも要らない従来のクエリで読み、取得後に `_meta.mastodonId` で並べ替える。
   `_meta.mastodonId` を欠くドキュメントも落とさない (Firestore の `orderBy` はフィールドを欠くものを結果から外すため)。
   これにより、デプロイ直後のインデックス作成中・バックフィル前でも配送は壊れない。
5. **インデックスとバックフィル:** `_meta.collection` (array-contains) + `_meta.mastodonId` 降順の複合インデックスを追加し、
   既存の `streams` には `functions/bin/backfillStreamMastodonId.ts` で入れる (`assignMastodonIds.ts` で採番済みの ID を使う)。
   ページ単位の取得は、バックフィルまでは `_meta.mastodonId` を欠くアクティビティを返さない。デプロイ後すぐに実行する。

## 結果

- 各コレクションがページをまたいでも新しい順に並ぶ。
- ドキュメント ID の降順の複合インデックスは不要になる。
