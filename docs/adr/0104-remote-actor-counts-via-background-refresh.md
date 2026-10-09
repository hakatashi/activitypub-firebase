# ADR-0104: リモートアカウントの件数はプロフィール閲覧時に Cloud Tasks で取得して `_meta` に持つ

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

Issue #229。リモートアカウントの Account は `followers_count` / `following_count` / `statuses_count` が 0、
`created_at` が `2021-01-01`、`last_status_at` が空の固定値だった
([ADR-0075](0075-recompute-follow-counts.md) の「未対応」)。件数は actor 自体には載っておらず、
`followers` / `following` / `outbox` コレクションを取得して `totalItems` を読む必要がある
(Mastodon も `ActivityPub::ProcessAccountService` でそうしている)。

## 決定

1. **件数はプロフィールを単体で見たとき (`GET /api/v1/accounts/:id`・`/lookup`) に、保存した値が
   24 時間より古ければ Cloud Tasks (`remoteActorRefreshTask`) に取得を頼む。** レスポンスは保存済みの値で
   即座に返し、外部への取得を待たない ([ADR-0064](0064-get-delete-statuses-and-context.md)、[ADR-0073](0073-lookup-cached-remote-accounts.md) の方針)。タイムラインなどで Account を
   まとめて組み立てる場面 (`userIdsToAccountsMap`) では頼まない。
2. タスク ID を「actor IRI のハッシュ + 日付」にして、同じ actor への依頼を 1 日 1 回に抑える
   (Cloud Tasks の重複排除。重複は失敗扱いにせず無視する)。
3. **保存先は actor の `_meta.followersCount` / `followingCount` / `statusesCount` / `lastStatusAt` /
   `countsFetchedAt`。** `Store#saveObject` / `updateObject` は既存の `_meta` を引き継ぐ ([ADR-0053](0053-prevent-object-corruption-and-counter-underflow.md))
   ので、`Update(Person)` で actor が上書きされても消えない。
4. **取得に失敗したコレクション (非公開・`totalItems` なし・相手が落ちている) は前回の値を残し、
   一度も取れていなければ 0 を返す。** `countsFetchedAt` は失敗時も更新し、再試行は翌日の閲覧に任せる
   (タスクの `maxAttempts` は 1)。
5. `last_status_at` は手元にあるその actor の最新の Note の `published` の日付。タスクの中で
   `getNotes` を 1 件引いて `_meta.lastStatusAt` に入れ、Account の組み立てではクエリしない。
6. `created_at` は actor の `published` を UTC の 0 時に丸めたもの (Mastodon と同じ)。なければ従来の固定値。
7. 外部への取得は `social/remoteResolution.ts` (`search.ts` から切り出した SSRF・オリジン検証付きの
   取得処理) を使い、件数の処理は `social/remoteActorCounts.ts` に置く。`mastodon/` には依存しない
   ([ADR-0080](0080-social-domain-layer-and-dependency-direction.md))。Account の組み立ては `_meta` を読むだけ。

## 理由

- 閲覧に応じて取得するので、見られないアカウントのために外部へ取りに行く費用がかからない。
- 件数は多少古くても困らない値なので、1 日 1 回の更新で足りる。
- 未解決の actor をバックグラウンドで解決する Issue #244 も同じタスクキューと
  `remoteResolution.ts` に乗せられる。

## 結果

- 初めて開いたプロフィールは件数 0 のまま表示され、次に開いたときに実際の値になる。
- `last_status_at` は最大 1 日遅れる。

## 参照

- [[0053-prevent-object-corruption-and-counter-underflow]]、[[0064-get-delete-statuses-and-context]]、[[0073-lookup-cached-remote-accounts]]、[[0075-recompute-follow-counts]] (の「未対応」を解消する)、[[0080-social-domain-layer-and-dependency-direction]]、[[0097-search-and-resolve-remote-resources]]
- 関連 Issue: [#229](https://github.com/hakatashi/activitypub-firebase/issues/229)、[#244](https://github.com/hakatashi/activitypub-firebase/issues/244)
