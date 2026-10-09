# ADR-0102: 返信数を返信先 Note の `_meta.repliesCount` に Store で非正規化する

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

Issue #226。Status の `replies_count` は `note.replies.totalItems` から取っており、ローカルの Note は
`replies` を持たないため常に 0 だった。返信 Note は `_meta.inReplyTo` に返信先 IRI を持つ (ADR-0086)。
数え方の候補は「非正規化カウンタ」と「Status を組み立てるたびに `count()` 集計を投げる」の2つで、
後者はタイムライン1ページで最大40本の集計クエリになる。Delete で届く Tombstone は `inReplyTo` を持たない。

## 決定

1. **返信先 Note の `_meta.repliesCount` に非正規化カウンタとして持つ。** 集計クエリは読み取り時に投げない。
2. **増減は `Store` が `objects` を書き換えるトランザクション内で、書き換え前後の差分から計算する**
   (`saveObject` / `updateObject`。ADR-0082 の射影と同じ考え方)。ある Note が「数える返信」であるとは、
   type が Note (Tombstone でない)、`inReplyTo` が自分以外を指し、公開範囲が `direct` でないこと
   (Mastodon の `Status#increment_counter_caches` も `direct` を数えない)。前後で返信先が同じなら増減しないので、
   同じ返信を何度保存しても数え直さない (冪等)。Tombstone 化は書き換え前の `inReplyTo` を見て −1 する。
3. 返信先が手元にないときは数えない。代わりに **Note を新規保存するとき、既に手元にある返信を数えて初期値にする**
   (`_meta.inReplyTo` の等価条件で引く)。返信が返信先より先に届いた場合も正しい値になる。
4. 0 未満にはしない (ADR-0053)。閲覧者から見えない `private` の返信も数える (Mastodon と同じ)。
5. Status の `replies_count` は **`_meta.repliesCount` と受信した `replies.totalItems` の大きい方** にする。
   リモートの投稿では相手の数の方が正確なことが多く、手元の数はその下限になるため。
6. 既存データは `functions/bin/backfillRepliesCount.ts` で数え直す。

## 理由

- `onStreamCreated` (ADR-0037) で数える案は、Tombstone が `inReplyTo` を持たず −1 の対象が分からず、
  `Update(Note)` で返信先や公開範囲が変わった場合も追えないため採らなかった。
  Store は `objects` の唯一の書き込み口なので、どの経路の保存・Tombstone 化も漏れない。
- 集計クエリ案は常に正しいが、読み取りのたびに Note の件数分の集計が走り、タイムラインが遅くなる。

## 結果

- `objects` の書き換えは返信先 Note の読み取り・書き込みを伴う (返信先が同じトランザクションに入る)。
- 公開範囲の判定は `noteToVisibility` の推定 (`{actor}/followers`) に従う。

## 参照

- 関連 ADR: [[ADR-0037]] [[ADR-0053]] [[ADR-0082]] [[ADR-0086]]
- 関連コード: `functions/src/store/replies.ts`、`functions/src/store/index.ts`
