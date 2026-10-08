# ADR-0099: タイムライン構築時に未解決アクターを安全にフォールバックする

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

タイムラインや通知の組み立てでは、ノートの投稿者やリプライ先、ブースト主の IRI を集めて
`userIdsToAccounts` で一括解決する。しかしリプライ先のノートだけが手元にあってその投稿者アクターが
手元に保存されていない場合など、一部のアクターが DB に存在しない状況が発生する。
従来の `userIdsToAccounts` は `assert(actor !== undefined)` しており、アクターが1人でも
欠損していると 500 エラーになり、ホームタイムライン全体が開けなくなっていた (dev 環境で発生)。
また `zip` で Map を作っていたため、長さに差異が生じると対応関係が狂う危険があった。

## 決定

1. **`userIdsToAccountsMap` の導入。** アクター IRI 配列を受け取り、手元の `objects` に存在する
   アクターのみを `Map<string, Account>` として返す関数を新設する。見つからないアクターは Map に
   含めず、例外を投げない。
2. **タイムライン・ステータス構築での Map 直接利用。** `notesToStatuses` および
   `timelineItemsToStatuses` は `userIdsToAccountsMap` を直接使い、`zip` を撤廃する。
   - ノート投稿者が解決できないノートはスキップする。
   - リプライ先アクターが解決できない場合は `inReplyTo: undefined` としてノート自体は表示する。
   - ブースト主が解決できないブーストはスキップする。
3. **`userIdsToAccounts` の安全化。** 見つからなかったアクターを除外し、存在する Account のみを返す。
   フォロワー・フォロー中一覧も存在するアクターのみで構成し、カーソルとの整合性を保つ。

## 理由

- サーバーレス環境でのタイムライン取得時に同期的なリモート actor 取得を行わない方針 ([[0059-never-refetch-local-objects]], [[0073-lookup-cached-remote-accounts]]) と整合させる。
- 1件の関連アクター欠損でタイムライン全体が落ちる障害を防ぎ、表示可能な投稿を安全に提供する。

## 参照

- 関連 Issue: なし (dev 環境の GET /api/v1/timelines/home 障害)
- 関連 ADR: [[0059-never-refetch-local-objects]], [[0069-mastodon-account-id-and-status-mentions]], [[0073-lookup-cached-remote-accounts]], [[0096-boosts-in-timelines-and-account-statuses]]
