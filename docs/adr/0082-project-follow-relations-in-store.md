# ADR-0082: フォロー関係を userInfos のサブコレクションに射影し、Store で差分更新する

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Issue #193。フォロー関係はリクエストのたびに `streams` の Follow / Accept / Undo を全件読んで導出しており、
カウンタも Follow / Accept / Undo の書き込みごとに全件数え直している(ADR-0075)。
Phase 5 の引っ越しで Follow が殺到すると O(N²) の read になる。

## 決定

1. **データモデル。** `userInfos/{ローカル actor}/following/{相手}` と `.../followers/{相手}` に、相手ごとに 1 件の射影を持つ。
   ドキュメント ID は相手の IRI(`escapeFirestoreKey`)。フィールドは `actor`・`followIri`・`followMastodonId`・
   `state`(following のみ。`pending` / `accepted`)・`createdAt` と、その相手への生きている Follow の一覧 `follows`。
   代表の `followIri` は `follows` から決める(承認済みを優先し、同順位なら Mastodon ID が最大のもの)。
   `follows` を持つことで、同じ相手への Follow が複数あっても、1 件が消えたときにクエリせず残りから代表を選び直せる。
2. **判定基準は Follow の `_meta.collection`(apex が管理する所属)とする。**
   - followers: ローカル actor 宛の Follow が `followers` コレクションに所属している。
   - following: ローカル actor 発の Follow が存在し、`rejections` に所属していない。`following` に所属していれば `accepted`、なければ `pending`。
   - Undo は apex が `Store#removeActivity` で Follow を消すので「Follow が存在しない」として扱う。
   これは apex 自身の followers / following コレクションと同じ基準で、Reject(受信・送信とも)も正しく反映される。
3. **更新は Store のフックで、元の書き込みと同じトランザクション内で行う。**
   `saveActivity` / `updateActivityMeta` / `removeActivity` が Follow を書き換えるとき、書き換え前後の Follow から
   射影の差分を計算する(`functions/src/projections/follows.ts`)。`removeSupersededFollows` も同じ関数を通して削除する。
   Firestore トリガーは採らない: 遅延があり、Mastodon API の follow 直後の relationships が古くなる。
   また at-least-once と自己再発火への備えが要る。Store は本体のモジュールなので ADR-0042 の境界にも反しない。
4. **カウンタは差分で更新する。** 射影の作成時だけ +1、実際の削除時だけ −1(following は `accepted` への遷移で ±1)。
   書き換え前後の状態から差分を出すので、同じ操作の再実行(再送・同じコレクションへの再追加)では値が動かない。
   userInfos が存在しなければカウンタは更新しない(ADR-0039)。
5. 射影モジュールは `social/` より下の層(`store` と同じ層)に置き、`social/` や `mastodon/` を import しない。
   Phase 4 の通知など、アクティビティからユーザー別の保存先への射影は同じ形で `projections/` に置く。
6. 既存データは `functions/bin/backfillFollowProjection.ts` で、全 Follow から同じ関数で射影を組み立て直し、
   カウンタも射影から書き直す。既存の関数(`collectFollowers` / `resolveOutgoingFollows`)との差分を出力して突き合わせる。

## 結果

- 移行期間(#194 まで)は ADR-0075 の再計算(`recomputeLocalFollowCounts`)も並行して動き、同じカウンタを書く。
  正常系では両者は一致する。Reject された Follow などで食い違う場合は、トリガーで後から動く再計算の値が残る。
- 読み取り側の切り替えと再計算の撤去は #194 で行う。

## 参照

- [[0075-recompute-follow-counts]]、[[0070-status-viewer-attributes-and-storage]]、[[0042-apex-fork-responsibility-boundary]]、[[0080-social-domain-layer-and-dependency-direction]]
- 関連 Issue: [#193](https://github.com/hakatashi/activitypub-firebase/issues/193)
