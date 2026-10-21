# ADR-0140: リモートアカウントの過去の公開投稿を、プロフィール閲覧時に outbox から補完する

- **Status:** Accepted
- **Date:** 2026-10-22

## 背景

Issue #320。リモートアカウントの投稿一覧には、受信した (フォローしてから届いた) 投稿しか出ない。
Mastodon / Misskey にもフォロー時に過去投稿を補完する機能はないが、公開投稿は相手の `outbox` から取得できる。

## 決定

1. **きっかけはプロフィールの閲覧だけ。** [ADR-0104](0104-remote-actor-counts-via-background-refresh.md) の件数と同じく、
   `GET /api/v1/accounts/:id`・`/lookup` でリモート actor を見たとき、actor の `_meta.outboxFetchedAt` が無いか
   24 時間より古ければ `remoteActorRefreshTask` に `kind: 'outbox'` で頼む。フォロー成立時には頼まない。
   タスク ID は「`outbox` + actor IRI のハッシュ + 日付」で、同じ actor への取得は 1 日 1 回まで。
2. **取得の範囲。** outbox の `first` から `next` を辿って最大 2 ページ・40 件。外部へのリクエストは 1 回のタスクで
   outbox 本体を含めて最大 10 回で、並行させずに順に行う。outbox は actor と同じオリジンのものだけを辿る。
3. **取り込むもの。** `Create` のうち、`actor` がその actor で、オブジェクトが Note、`attributedTo` がその actor、
   `id` のオリジンが actor と同じ ([ADR-0046](0046-validate-owner-same-origin-in-apex.md) と同じ考え方)、
   宛先に `as:Public` を含む (public / unlisted) もの。オブジェクトが IRI だけなら取得する (上記の回数に含む)。
   `Announce` やピン留め (`featured`) は取り込まない。
4. **保存は Note だけを `Store#saveObject` で行い、`Create` は `streams` に保存しない。** 通知の射影
   ([ADR-0088](0088-project-notifications-in-store.md)) はアクティビティから作るので通知は出ない。
   Mastodon ID は `published` から採番する ([ADR-0058](0058-mastodon-id-snowflake-layout.md)) ので、
   フォロー中の相手ならホームのタイムラインの射影 ([ADR-0136](0136-fan-out-home-and-list-timelines-on-write.md)) にも入るが、
   本来の時刻の位置に並び、新着として先頭には出ない (Mastodon の `merge_into_home` と同じ)。
5. **手元にある Note は書き換えない。** 受信した投稿の `_meta` や、受信した編集を古い内容で戻さないため。
   したがって補完した投稿の編集・削除には、`Update` / `Delete` が届かない限り追従しない。
6. **取得できないとき** (authorized fetch で拒否・outbox が空や件数のみ・相手が落ちている) は何も保存せず、
   `outboxFetchedAt` だけを更新して翌日の閲覧に任せる (タスクの `maxAttempts` は 1 のまま)。
   取得の GET はローカル actor の鍵で署名する ([ADR-0098](0098-sign-outgoing-get-with-local-actor.md)) ので、
   authorized fetch でも取得できることがある。
7. 処理は `social/remoteOutbox.ts` に置く ([ADR-0080](0080-social-domain-layer-and-dependency-direction.md))。Mastodon・Misskey の API は使わない。

## 理由

- 閲覧に応じて取得するので、見られないアカウントのために外部へ取りに行く費用がかからない。フォロー時は
  直前にプロフィールを見ていることが多く、別のきっかけを足す利点が小さい。
- 件数と同じキューに載せるので、レート制限 (`maxDispatchesPerSecond: 2`) を共有して相手への負荷を抑えられる。

## 結果

- 初めて開いたプロフィールは補完前の一覧で表示され、取得後に開き直すと過去の投稿が出る。
- 補完した投稿が相手側で削除されても、手元では消えない。

## 参照

- 関連 Issue: [#320](https://github.com/hakatashi/activitypub-firebase/issues/320)
- [[0046-validate-owner-same-origin-in-apex]]、[[0058-mastodon-id-snowflake-layout]]、[[0080-social-domain-layer-and-dependency-direction]]、[[0088-project-notifications-in-store]]、[[0098-sign-outgoing-get-with-local-actor]]、[[0104-remote-actor-counts-via-background-refresh]]、[[0136-fan-out-home-and-list-timelines-on-write]]
