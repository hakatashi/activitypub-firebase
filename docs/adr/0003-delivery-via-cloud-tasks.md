# ADR-0003: 配送は Cloud Tasks で行う

- **Status:** Accepted
- **Date:** 2026-09-03

## 背景

ActivityPub の配送(自分のアクティビティをリモートの inbox へ HTTP POST すること)は、
ActivityPub 仕様 7. Delivery で「非同期に行うべき」「ネットワークエラー時は再試行すべき」とされている。

apex はこれを常駐プロセスの `setInterval` ループで実装している(`pub/federation.js:101-144`)。
Cloud Functions には常駐プロセスがなく、このループを起動する仕組みがこのリポジトリには存在しない。
結果として、**投稿や Accept を `deliveryQueue` に積んでも実際にリモートへ届く経路がない。**
これがプロジェクト最大のブロッカーである。

apex のループは Cloud Functions 上では原理的に動かない。`isDelivering` フラグがモジュール
グローバルで、`deliveryDequeue()` が reject すると `true` のまま残り、インスタンスが再利用されると
以後永久に no-op になる。また11回リトライ後は黙って破棄する。

## 決定

**Google Cloud Tasks を使う。** 具体的には:

1. apex を `offlineMode: true` で初期化し、内蔵の配送ループを停止する。
2. `Store#deliveryEnqueue` を、Firestore への書き込みではなく **Cloud Tasks へのタスク発行**に置き換える
   (`firebase-admin/functions` の `getFunctions().taskQueue(...).enqueue()`)。
   受信者(inbox URL)1件につき1タスク。
3. `onTaskDispatched`(`firebase-functions/v2/tasks`)で配送ワーカー Function を定義し、
   その中で `apex.deliver(actorId, body, address, signingKey)` を呼ぶ。
4. **リトライと指数バックオフは Cloud Tasks の `retryConfig` に委譲する。**
   `Store#deliveryDequeue` / `deliveryRequeue` と `deliveryQueue` コレクションは廃止する。
5. **秘密鍵をタスクペイロードに載せない。** `actorId` のみ渡し、ワーカー内で
   `store.getObject(actorId, true)` から鍵を引く。
6. 恒久的な失敗(401 / 403 / 404 / 410)はリトライせず即座に破棄する。
   5xx とネットワークエラーのみリトライ対象とする。
7. 配送の結果(受信者・ステータス・試行回数・エラー)を Firestore に記録し、後から確認できるようにする。

## 理由

Cloud Tasks は完全サーバーレスで、タスク単位のスケジューリングと指数バックオフを標準で備えており、
ポーリングのコストがない。無料枠も月100万オペレーションと十分。

検討した代替案:

- **`onSchedule` で定期的に `apex.runDelivery()` を叩く** — 最小の変更で済むが、
  `federation.js:143` の自己再帰でループが走り続け、`isDelivering` のプロセス跨ぎ問題も残る。
  加えて配送がない時間帯もポーリングコストがかかる。
- **`addToOutbox` 内で同期的に配送を完結させる** — フォロワー数に比例してレスポンスが遅くなり、
  1件でも失敗するとリトライ手段がない。`third_party/minidon` がこの方式だが、
  リトライも sharedInbox 対応も持っていない。
- **Pub/Sub + Cloud Scheduler** — Cloud Tasks に対する優位性がない。

なお、apex の既存の `deliveryEnqueue` は秘密鍵をキューレコードに焼き込む設計で、
鍵ローテーション時にキュー内の鍵も一括更新するという複雑さを生んでいた
(`functions/src/store.ts:436-446`)。Cloud Tasks へ移すことでこの複雑さも消える。

## 結果

- `deliveryQueue` コレクションと関連する Store メソッド3つが不要になる。既存データは破棄してよい。
- Cloud Tasks API の有効化と、タスクを発行するサービスアカウントへの
  `roles/cloudtasks.enqueuer` 付与が必要になる。
- 恒久失敗した配送先(消えたサーバー)をフォロワーから削除する処理は、当面実装しない。
  記録だけ残し、必要になったら別 ADR で扱う。
- 大量配送時のファンアウトはタスク数に比例するが、apex が既に sharedInbox 優先の
  受信者解決を行っている(`pub/activity.js:115`)ため実用上問題にならない見込み。

## 参照

- [[ADR-0002]] activitypub-express を継続利用する
- 参考実装: `third_party/minipub/src/rpc/federate_activity.ts`
  (受信者ごとの状態機械。べき等な再実行が可能な設計として参考になる)
- ActivityPub 仕様 7. Delivery: `third_party/activitypub/index.html`
