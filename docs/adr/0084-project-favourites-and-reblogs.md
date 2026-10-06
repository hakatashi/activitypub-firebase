# ADR-0084: お気に入り・ブーストの閲覧者状態を userInfos のサブコレクションに射影する

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Issue #195。Status の `favourited` / `reblogged` は、閲覧者が送った Like / Announce / Undo を
`streams` から全件読んで判定していた(ADR-0070)。認証付きでタイムラインを 1 ページ出すたびに走り、
unfavourite / unreblog も取り消す対象を探すために同じ全件読み取りをしていた。

## 決定

1. **データモデル。** `userInfos/{ローカル actor}/favourites/{Note}` と `.../reblogs/{Note}` に、Note ごとに 1 件の射影を持つ。
   ドキュメント ID は Note の IRI(`escapeFirestoreKey`)。フィールドは `object`(Note の IRI)・
   `activityIris`(その Note への生きている Like / Announce の IRI の一覧)・`createdAt`。
   同じ Note への Like が複数あっても(競合・過去データ)、1 件が消えたときにクエリせず残りで判定できるよう一覧で持つ。
2. **判定基準は「ローカル actor 発の Like / Announce が `streams` に存在すること」とする。**
   取り消しは Undo の送信と同時に `Store#removeActivity` で元のアクティビティを消すので、Undo とは突き合わせない。
   リモートからの Like / Announce は対象 Note の `_meta.likesCount` / `sharesCount`(ADR-0037)の領分で、射影しない。
3. **更新は ADR-0082 と同じく Store のフックで、元の書き込みと同じトランザクション内で行う**
   (`functions/src/projections/reactions.ts`)。`saveActivity` / `removeActivity` / `updateActivityMeta` が
   書き換え前後のアクティビティから差分を計算する。寄与が変わらない書き換え(再送・`liked` への追加)では読み書きしない。
   Store が呼ぶ射影は `projections/index.ts` でまとめ、すべての読み取りの後にまとめて書く。
4. **読み取り。** `favourited` / `reblogged` は対象 Note の射影ドキュメントを `getAll` で引いて判定する。
   unfavourite / unreblog は射影の `activityIris` のアクティビティをすべて Undo する。
   `streams` に元のアクティビティが残っていない(射影だけが残った)IRI は射影から外す。
5. 既存データは `functions/bin/backfillReactionProjection.ts` で、ローカル actor の Like / Announce から組み立て直す。
   ADR-0070 の時期に Undo されたまま `streams` に残っているものは除く。
6. ADR-0070 のうち favourited / reblogged の判定方法をこの ADR で supersede する。bookmark / pin の扱いはそのまま。

## 結果

- 閲覧者状態の判定は、表示する Note の数に比例する読み取りだけになる。
- デプロイからバックフィル実行までの間は、既存のお気に入り・ブーストが未設定に見える。単一ユーザー運用なので許容し、1 つの PR で切り替える。
- `GET /api/v1/favourites` は射影から作れるようになるが、実装は Phase 4 で行う。

## 参照

- [[0082-project-follow-relations-in-store]]、[[0070-status-viewer-attributes-and-storage]]、[[0037-denormalize-like-announce-counts]]
- 関連 Issue: [#195](https://github.com/hakatashi/activitypub-firebase/issues/195)
