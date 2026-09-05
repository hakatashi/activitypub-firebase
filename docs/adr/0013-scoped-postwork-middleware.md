# ADR-0013: `postWork` はレスポンス前に実行し続け、パッチをリクエストスコープに閉じる

- **Status:** Accepted
- **Date:** 2026-09-05

## 背景

apex はレスポンス送出後(`onFinished`)に `postWork` と `apex-inbox` / `apex-outbox` イベントを
実行する設計だが、Cloud Functions ではレスポンス後の CPU 割り当てが保証されない。
そのため送出**前**に実行する必要がある([Issue #19](https://github.com/hakatashi/activitypub-firebase/issues/19))。

現状はこれを `express.response.send` のプロトタイプ書き換えで実現しており、
同一プロセスで動く `mastodonApi`(`api.ts` が `apex` を import するためロード時にパッチが効く)まで
巻き添えになっていた。

配送を Cloud Tasks に移した後([ADR-0003](0003-delivery-via-cloud-tasks.md))、`postWork` の中身は
`publishActivity` / `publishUpdate` による**宛先解決(Firestore の読み取り)と Cloud Tasks への
enqueue** だけになり、リモートサーバーへの HTTP POST とその応答待ちは含まれなくなった。
inbox の応答が相手のタイムアウトに達する主要因は消えている。

## 決定

**`postWork` をレスポンス前に await する方針は維持する。副作用のタスク化は行わない。**
ただしグローバルなプロトタイプ書き換えをやめ、`functions/src/postWork.ts` の
`runPostWorkBeforeSend` ミドルウェアで**リクエストごとに `res.send` を差し替える**。
このミドルウェアは `activitypub` の express app にのみ適用する。

あわせて `postWork` の所要時間を `postWorkCompleted` ログ(`durationMs` / `postWorkDurationMs` /
`eventDurationMs` / `taskCount`)として構造化出力し、継続的に計測できるようにする。

## 理由

- 副作用を全てタスク側へ寄せるには、apex の `inboxSideEffects` / `outboxSideEffects` を迂回して
  受信処理を自前で組み直す必要があり、事実上 apex の fork になる。
  [ADR-0002](0002-keep-activitypub-express.md)(apex を継続利用する)と衝突し、
  得られるのは数百ミリ秒のレイテンシ削減にすぎない。
- 一方、`mastodonApi` への巻き添えは実害があり、apex に手を入れずに解消できる。
  費用対効果が明確に違うため、後者だけを行う。
- apex の `onFinished` ハンドラは残るが、実行済みの `postWork` は空配列に、`eventName` は
  `null` に落としてあるため二重実行されない(現行の挙動を踏襲)。

## 結果

- `mastodonApi` のレスポンスは素の `express.response.send` に戻る。
  `mastodonApi` が `apex` を通すのは nodeinfo の2ルートのみで、`postWork` を積まないため挙動は変わらない。
- 計測ログの `durationMs` が inbox で常態的に数秒に達するようなら、この決定を別 ADR で見直す。
- ログに出していた `res.locals.apex` 全体には `targetActorWithMeta` が入れた `_meta.privateKey` が
  含まれうるため、安全なフィールドのみを抜き出して出力する。

## 参照

- 関連 ADR: [[ADR-0002]], [[ADR-0003]]
- 関連コード: `functions/src/postWork.ts`, `functions/src/activitypub.ts`
- apex 側の該当実装: `activitypub-express/index.js`(`onFinishedHandler`), `net/activity.js`
