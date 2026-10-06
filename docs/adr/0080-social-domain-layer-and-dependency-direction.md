# ADR-0080: ソーシャルドメイン層の切り出しと依存方向の単方向化

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

`functions/src/mastodon/api.ts` にソーシャルグラフ(フォロー関係)・タイムライン・スレッド探索などのドメインロジックが埋もれており、Firestore トリガー(`denormalizations.ts`)がフォロー数再計算のために HTTP ルート層を丸ごと読み込む依存逆転が生じていた。また、`activitypub.ts` から `apex` を再 export して各所から import することで不要な Express アプリ構築等の副作用が波及し、フォロー判定も複数関数で乖離していた。

## 決定

1. ソーシャルグラフ・タイムライン・スレッド探索のドメインロジックを `functions/src/social/` (`follows.ts`, `timelines.ts`, `threads.ts`, `visibility.ts`) に切り出す。
2. 依存の向きを `entrypoints` (Functions) → `mastodon/api.ts` (HTTP ルート/presenter) → `social/` (ドメイン) → `store` / `apex.ts` の単方向に固定する。
3. `social/` から `mastodon/` や `express` の import を禁止し、Mastodon エンティティへの変換 (presenter) は `mastodon/` 側に残す。`denormalizations.ts` から `mastodon/` の import を禁止する。これを oxlint で強制する。
4. `apex` は必ず `functions/src/apex.ts` から import し、`activitypub.ts` からの import を撤廃する。
5. フォロー中の判定ロジックを統合し、同じ対象へのクエリを重複発行しないように派生させる。

## 理由

- HTTP ルーティング層とプロトコル・ドメインロジックの関心事を分離し、トリガー実行時や他機能からの読み込みにおける無駄な依存とコールドスタート負荷を排除するため。
- フォロー判定を単一の真実源(`resolveOutgoingFollows` / `collectFollowers`)に集約し、Undo 考慮漏れやクエリ重複を防ぐため。

## 結果

- Firestore トリガーは `social/` のみを読み込み、Mastodon API ルーターを読み込まなくなる。
- `activitypub.ts` はエントリポイントとして独立し、`apex` の不用意な再エクスポートによる副作用の波及が防がれる。
- 今後追加するソーシャル機能やタイムライン機能は `social/` に実装し、Mastodon API はその presenter / ルートハンドラとして実装する制約が課される。

## 参照

- 関連 ADR: [ADR-0042](0042-apex-fork-responsibility-boundary.md), [ADR-0061](0061-timeline-actor-filter-and-visibility.md), [ADR-0075](0075-recompute-follow-counts.md)
- 関連 Issue: #189
