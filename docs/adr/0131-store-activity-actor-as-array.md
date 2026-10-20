# ADR-0131: インポートしたアクティビティの `actor` を apex の保存形式(配列)に揃える

- **Status:** Accepted
- **Date:** 2026-10-20

## 背景

投稿履歴のインポート(ADR-0126、`src/social/archive.ts`)は `Create` / `Announce` の `actor` を
文字列のまま `apex.store.saveActivity` に渡していた。ほかの経路(apex の正規化を通るもの)は
`actor` が配列で保存されるため、`where('actor', 'array-contains', ...)` で引くクエリ
(`rebuildReactionProjection` の Like / Announce の取得など)からインポート分だけが漏れた(#323)。
本番では Create 6,856 件・Announce 60 件が文字列だった。

## 決定

- インポートは `actor` を `[localActor.id]`(配列)で保存する。
- 既存分は `functions/bin/backfillActivityActorArray.ts` で、文字列の `actor` を配列に書き直す。
  冪等で、`--dry-run` で件数だけ確認できる。preflight の「データの整合性」に加えて、
  このずれを `updated != 0` として検出する。
- `_meta.actors` は `toIdArray(actor)` から作られるため、この変更の影響を受けない。

## 結果

- `actor` を `array-contains` で引くクエリがインポートした投稿を拾う。
  `backfillReactionProjection` の本実行でインポートしたブーストの射影が消えなくなる。
- 本番のバックフィルの本実行はユーザーの承認を得てから行う。
