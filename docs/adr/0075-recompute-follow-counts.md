# ADR-0075: フォロー数・フォロワー数は差分更新ではなく再計算で持つ

- **Status:** Superseded by ADR-0082
- **Date:** 2026-10-06

## 背景

Issue #174。`userInfos.followers_count` は Follow を受信した時点で +1 する差分更新で、
Accept 済みかどうか・同じ相手からの重複 Follow かどうかを見ていなかった。
このため一覧 (`/followers`) は 5 件なのにカウンタは 19 になっていた。
`following_count` は更新処理自体がなく常に 0 だった。
自分発の Follow には `_meta.isPublic` が立たず、匿名の AP `following` の `orderedItems` も空だった。

## 決定

1. **ローカルユーザーの `followers_count` / `following_count` は差分ではなく再計算する。**
   Follow / Accept / Undo の stream が書き込まれたとき (`onStreamWritten`、`_meta.index` 更新後)、
   Mastodon API のフォロワー/フォロー一覧と同じ関数 (`getFollowerActorIris` / `collectFollowing`)
   で「Accept 済み・Undo されていない・相手ごとに 1 件」を数え直して書き込む。
   再計算は冪等なので、トリガーの再実行や重複配送でずれない。
2. `onStreamCreated` の `followersDelta` による差分更新は廃止する。
3. 自分発の Follow も作成時に `markActivityPublic` を呼び、`following` コレクションを
   匿名にも公開する (→ [ADR-0035](0035-mark-accepted-follow-as-public.md) の対象を拡張)。
4. 同じ actor から同じ相手への Follow を受信したら、古い Follow を削除して最新の 1 件だけ残す
   (`removeSupersededFollows`)。残すと AP `followers` コレクション (Follow アクティビティから
   導出される) に同じ actor が重複し、`totalItems` も水増しされる。
5. 既存データは `functions/bin/denormalizations.ts` が重複 Follow の削除と同じ再計算を実行して直す。
   残す Follow は Undo されていないもの → followers 所属のもの → 新しいもの、の順で選ぶ
   (`published` を持たない Follow が多く、Undo 済みを残すと現役のフォロワーが落ちるため)。

## 理由

一覧と同じ判定ロジックを共有すれば、カウンタと一覧が構造的に食い違わない。
単一ユーザー運用なので再計算のコスト (Follow 全件のクエリ) は小さい。

## 結果・未対応

- リモートアカウントの `followers_count` / `following_count` / `statuses_count` は引き続き 0
  (相手の actor コレクションの `totalItems` を取得する必要がありネットワーク往復を伴うため、別 Issue で扱う)。

## 参照

- [[0035-mark-accepted-follow-as-public]]
- 関連 Issue: [#174](https://github.com/hakatashi/activitypub-firebase/issues/174)
