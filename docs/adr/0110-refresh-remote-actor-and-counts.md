# ADR-0110: リモート actor 本体を取り直し、アバターなどの変更を反映する

- **Status:** Accepted
- **Date:** 2026-10-10

## 背景

手元に保存したリモート actor は `Update(Person)` が届かない限り更新されず、アバターや表示名の変更・削除が
反映されない (Issue #253)。[ADR-0104](0104-remote-actor-counts-via-background-refresh.md) は 24 時間ごとに
件数を取り直しているが、actor 本体 (`icon` / `image` / `name` など) は取り直していなかった。

## 決定

1. **プロフィール閲覧時に `remoteActorRefreshTask` ([ADR-0104](0104-remote-actor-counts-via-background-refresh.md)) で、
   件数と一緒にリモート actor 本体も外部から再取得する。** 頻度は 1 日 1 回。
2. 取得したオブジェクトは `isAPActor`・自ドメインでないこと・ID が一致することを検証し、
   `Store#updateObject` (`fullReplace`) で保存する。既存の `_meta` (件数・Mastodon ID 等) は引き継ぐ
   ([ADR-0053](0053-prevent-object-corruption-and-counter-underflow.md))。
3. `followers` / `following` / `outbox` のコレクション件数は、再取得した最新の actor から取り直す。
   件数・最終投稿日・`countsFetchedAt` は actor の `_meta` にマージして同時に保存する。
4. actor の取得に失敗した場合は既存の actor を維持し、`_meta.countsFetchedAt` のみ更新して翌日の閲覧に任せる
   ([ADR-0104](0104-remote-actor-counts-via-background-refresh.md) の方針)。
5. `Store#updateObject` により、`streams` 内の埋め込みコピーも最新の内容へ差し替えられる。

## 理由

- 件数の取り直しと actor 本体の取り直しの契機・頻度・タスクキューを統一でき、レート制限を共有して相手サーバーへの負荷を抑えられる。
- `fullReplace` により、相手がアバターやヘッダーを削除した場合も正しく反映される。

## 結果

- 古いアバター URL (404) が最新のものに更新される。
- `docs/known-issues.md` の「キャッシュしたリモート actor が更新されない」を解消する。

## 参照

- [[0053-prevent-object-corruption-and-counter-underflow]]、[[0097-search-and-resolve-remote-resources]]、[[0104-remote-actor-counts-via-background-refresh]]
- 関連 Issue: [#253](https://github.com/hakatashi/activitypub-firebase/issues/253)
