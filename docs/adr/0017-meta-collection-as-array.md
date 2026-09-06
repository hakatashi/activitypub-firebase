# ADR-0017: `_meta.collection` を Firestore 上でも配列として保存する

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

apex は `_meta.collection` を「アクティビティが所属するコレクションの**集合**」として扱う。
MongoDB 実装の `updateActivityMeta`(`store/index.js:288-302`)は `$addToSet` / `$pull` を使い、
`hasMeta`(`pub/utils.js:66-71`)は `Array.isArray(obj._meta[key])` を要求し、`undo` の
side effect(`net/activity.js`)は `object._meta?.collection?.map(...)` と複数件の走査を
前提にしている。

一方 `functions/src/store.ts` はこれをスカラー1件に潰していた。`updateActivityMeta` は
`activityData._meta[key] = value` で上書きし、`normalizeActivity` / `denormalizeActivity` が
保存・読み出しのたびに配列⇄文字列を変換しつつ先頭要素だけを残していた。その結果、
`acceptFollow`(`pub/activity.js:132-139`)が受理済み `Follow` の `_meta.collection` を
inbox の IRI から followers の IRI へ**置き換えてしまい**、受理した `Follow` が inbox
コレクションから消える、`undo` が影響を受けた全コレクションを更新できない、`Reject` の
`hasMeta` チェックが成立しない、といった破綻が起きていた(詳細は Issue #47)。

[ADR-0016](0016-fix-update-activity-meta-array-corruption.md) は「配列で保存されると
`getStream` の等価フィルタが壊れる」ことを前提に `updateActivityMeta` の変異順序だけを
直す対症療法だった。今回はスカラー1件という前提そのものを撤回するため、ADR-0016 を
supersede する。

## 決定

**`_meta.collection` を Firestore 上でも配列として保存する。** スカラーへの変換は行わない。

- `getStream` / `getStreamCount` の `.where('_meta.collection', '==', ...)` を
  `.where('_meta.collection', 'array-contains', ...)` に変更する。
- `updateActivityMeta` を MongoDB 実装と同じ意味論(重複を作らない追加 / 単一値の除去)に
  書き換える。
- `normalizeActivity` / `denormalizeActivity` は不要になるため削除する。
- `firestore.indexes.json` の該当フィールドを `arrayConfig: CONTAINS` に変更する。
- 既存の `streams` ドキュメントはスカラーのまま残っているため、
  `functions/bin/denormalizations.ts` に配列化するバックフィル処理を追加する。

## 理由

- apex 本体のデータモデルとスカラー⇄配列の変換層を挟まずに一致させることで、
  ADR-0016 のバグを生んだ変換層そのものをなくせる。
- Firestore の `array-contains` はまさにこの用途(集合の所属判定)のために存在する。

## 結果

- ADR-0016 の `structuredClone` による対症療法は不要になる(変換自体をやめるため)。
- デプロイ前にバックフィルスクリプトを実行しないと、既存アクティビティが
  `array-contains` クエリにヒットしなくなる(inbox / outbox / followers が空に見える)。

## 参照

- Supersedes [[0016-fix-update-activity-meta-array-corruption]]
- 関連 Issue: [#47](https://github.com/hakatashi/activitypub-firebase/issues/47)
- `functions/src/store.ts`, `functions/bin/denormalizations.ts`
