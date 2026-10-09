# ADR-0106: 手元にないリモート actor は見つけたときに Cloud Tasks で取得する

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

Issue #244。[ADR-0099](0099-graceful-fallback-for-unresolved-actors-in-timelines.md) で、手元にない actor が
タイムラインにあっても 500 にはならなくなったが、その投稿やブーストは飛ばされ、リプライ先の情報は空のままになる。
受信したブーストの元投稿の作者や、手元にあるリプライ先の Note の作者は、apex が取得しないので保存されない。
閲覧系 API の中で外部へ取りに行くと応答が遅れる ([ADR-0064](0064-get-delete-statuses-and-context.md)、[ADR-0073](0073-lookup-cached-remote-accounts.md))。

## 決定

1. **Account をまとめて組み立てる `userIdsToAccountsMap` で `objects` に無かったリモート IRI を、
   [ADR-0104](0104-remote-actor-counts-via-background-refresh.md) の `remoteActorRefreshTask` に
   取得させる。** レスポンスは ADR-0099 のフォールバックのまま返し、次のリクエストから表示される。
   タイムライン・通知・Status・フォロー一覧などはすべてこの関数を通る。
2. **inbox で `Create` / `Announce` を受け取ったとき、オブジェクトの `attributedTo` と、手元にある
   リプライ先 Note の `attributedTo` のうち手元にない actor を同じく取得させる。** 手元にないリプライ先 Note
   自体は取得しない (Note の取得は範囲外)。
3. タスクのペイロードに `kind: 'counts' | 'resolve'` を足す (省略時は `counts`)。`resolve` は
   `remoteResolution.ts` の `resolveRemoteActor` で取得・保存するだけで、件数は取らない
   (件数はプロフィールを開いたときに ADR-0104 の流れで取る)。
4. タスク ID は「`resolve` + actor IRI のハッシュ + 日付」。取得に失敗した actor は翌日まで頼み直さない。
5. 依頼は 1 リクエストあたり 10 件まで。同じインスタンスで頼んだタスク ID はメモリに覚え、
   Cloud Tasks への重複した依頼を減らす。依頼の失敗は呼び出し元に投げない。
6. ローカルの IRI・URL として不正な IRI は頼まない。

## 理由

- 欠けている actor を見つけるのはほぼ `userIdsToAccountsMap` なので、1 か所で拾える。
- 受信時に頼めば、ブーストが最初にタイムラインに出る前に actor が揃っていることが多い。
- キューを分けないので、レート制限 (`maxDispatchesPerSecond: 2`) を件数の取得と共有でき、相手サーバーへの負荷が増えすぎない。

## 結果

- 欠けた actor の投稿は、初回は表示されず、取得後のリクエストから表示される。
- 手元にないリプライ先 Note の作者は、この仕組みでは補完されない。

## 参照

- [[0064-get-delete-statuses-and-context]]、[[0073-lookup-cached-remote-accounts]]、[[0097-search-and-resolve-remote-resources]]、[[0098-sign-outgoing-get-with-local-actor]]、[[0099-graceful-fallback-for-unresolved-actors-in-timelines]]、[[0104-remote-actor-counts-via-background-refresh]]
- 関連 Issue: [#244](https://github.com/hakatashi/activitypub-firebase/issues/244)
