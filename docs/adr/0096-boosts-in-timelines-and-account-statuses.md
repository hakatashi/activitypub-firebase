# ADR-0096: ホームタイムラインとアカウント投稿一覧にブースト(Announce)を表示する

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

タイムラインは `objects` の Note のみを取得しており、ブースト(Announce)が表示されない (Issue #225, docs/known-issues.md)。
また `streams` には actor と published の検索用インデックスがなく、フォロワーのブーストを効率的に検索できない。

## 決定

1. **Announce の検索用非正規化。** `Store#saveActivity` で `_meta.actor` (先頭の actor) と
   `_meta.published` (ADR-0062 のソートキー) を書き込む (ADR-0086 と同方式)。
   複合インデックス `type + _meta.actor + _meta.published` (昇順・降順) でクエリする。既存データはバックフィルする。
2. **Note と Announce のマージ。** `functions/src/social/timelines.ts` で両方の情報源から
   `_meta.published` 範囲で取得し、Mastodon ID 順にマージする。それぞれのカーソルを独立して進め、
   可視性チェックを通過したものを集めて `takePage` する。
3. **重複排除。** 同一取得処理内で同一の Note IRI を指す重複ブーストが現れた場合、
   より新しいアイテムを優先し、重複するブーストは除外する (Mastodon の挙動に準拠)。
4. **可視性と適用範囲。** Announce 自体の可視性と元の Note の可視性 (public / unlisted かつ手元に存在)
   の両方を満たすもののみ表示する。`home` と `accounts/:id/statuses` に混ぜる
   (`exclude_reblogs=true` または `pinned=true` 時は除外、`timelines/public` には混ぜない)。
   `DELETE /api/v1/statuses/:id` で自分のブースト ID を受けた場合はブースト取り消しとして扱い、
   `/context` は空配列を返し、`favourite` などの操作は元の Note を対象とする (Mastodon 仕様準拠)。

## 参照

- 関連 Issue: [#225](https://github.com/hakatashi/activitypub-firebase/issues/225)
- 関連 ADR: [[0061-timeline-actor-filter-and-visibility]], [[0062-cursor-pagination-by-mastodon-id]], [[0086-normalize-object-query-fields-into-meta]], [[0095-represent-boost-as-status-entity]]
