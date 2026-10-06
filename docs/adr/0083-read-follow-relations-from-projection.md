# ADR-0083: フォロー関係の読み取りを射影に切り替え、全件の再計算を撤去する

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Issue #194。ADR-0082 で射影 (`userInfos/{ローカル actor}/following|followers/{相手}`) とカウンタの差分更新を
入れたが、読み取り側は引き続き `streams` の Follow / Accept / Undo を全件クエリしており、
`onStreamWritten` も Follow / Accept / Undo のたびに全件を数え直していた(ADR-0075)。

## 決定

1. **フォロー関係の読み取りはすべて射影から行う** (`functions/src/social/follows.ts`)。
   - フォロー中の集合(可視性判定・ホームタイムライン)は `following` の `state == 'accepted'` を読む。
   - `relationships` と follow / unfollow の応答の `following` / `requested` / `followed_by` は、
     相手ごとの射影ドキュメントを `getAll` で引いて判定する (`getFollowFlags`)。
   - `GET /api/v1/accounts/:id/followers|following` は `followMastodonId` の `orderBy` と範囲条件・`limit` で
     Firestore 側でページングする。カーソルの意味(Follow の Mastodon ID、ADR-0062)は変えない。
     `followMastodonId` が `null`(未採番)の射影はカーソルにできないので一覧から除く(文字列の範囲条件は `null` に一致しない)。
     `following` は `state` の等価条件と組むため、`state + followMastodonId` の複合インデックスを昇順・降順で持つ。
2. **リモートアカウント(`userInfos` を持たない)は対象外のまま。** followers / following のルートは
   `userInfos` を引いて見つからなければ 404 を返しており、もともと手元の Follow から一覧を作っていない。
   読み取り関数にリモートの actor を渡すと射影がないので空になる。streams を引く代わりの経路は残さない。
3. **全件の再計算を撤去する。** `recomputeLocalFollowCounts` と `onStreamWritten` からの呼び出し、
   `functions/bin/denormalizations.ts` のフォロー数の再計算を削除する。カウンタは ADR-0082 の差分更新だけで保ち、
   ずれたら `functions/bin/backfillFollowProjection.ts` で射影から書き直す。
   streams を全件読む旧来の判定関数 (`resolveOutgoingFollows` / `collectFollowers` など) も削除する。
   バックフィルは `rebuildFollowProjection` だけで完結するので、旧関数との突き合わせ出力もやめる。
4. AP の `followers` / `following` コレクションは引き続き apex が `_meta.collection` から作る。
   射影と同じ基準なので一致するはずで、テストで中身と `totalItems` の一致を確かめる。
   AP コレクションの `totalItems` を射影から返すかどうかは別 Issue で扱う。

## 結果

- Mastodon API のフォロー関係の判定は、相手の数に比例する読み取り(一覧のページ分、または相手ごとの 1 件)だけになる。
- 判定基準が「Accept アクティビティの有無」から「`_meta.collection` への所属」に変わる(ADR-0082)。
  手で streams に Follow / Accept を書くテストは、Store 経由で apex と同じ書き換えをするよう直した。

## 参照

- [[0082-project-follow-relations-in-store]]、[[0075-recompute-follow-counts]]、[[0062-cursor-pagination-by-mastodon-id]]
- 関連 Issue: [#194](https://github.com/hakatashi/activitypub-firebase/issues/194)
