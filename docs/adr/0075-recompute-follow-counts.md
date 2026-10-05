# ADR-0075: フォロー数・フォロワー数は差分更新ではなく再計算で持つ

- **Status:** Accepted
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
4. 既存データは `functions/bin/denormalizations.ts` が同じ再計算を実行して直す。

## 理由

一覧と同じ判定ロジックを共有すれば、カウンタと一覧が構造的に食い違わない。
単一ユーザー運用なので再計算のコスト (Follow 全件のクエリ) は小さい。

## 結果・未対応

- リモートアカウントの `followers_count` / `following_count` / `statuses_count` は引き続き 0
  (相手の actor コレクションの `totalItems` を取得する必要がありネットワーク往復を伴うため、別 Issue で扱う)。
- 同じ相手から複数の Follow が残り、一方だけ Undo された場合はフォロワーのまま残る
  (一覧と同じ挙動)。

## 参照

- [[0035-mark-accepted-follow-as-public]]
- 関連 Issue: [#174](https://github.com/hakatashi/activitypub-firebase/issues/174)
