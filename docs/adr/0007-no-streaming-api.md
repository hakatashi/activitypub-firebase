# ADR-0007: ストリーミング API は実装しない

- **Status:** Accepted
- **Date:** 2026-09-03

## 背景

Mastodon はタイムラインや通知のリアルタイム更新のために WebSocket / Server-Sent Events による
ストリーミング API を提供している(`GET /api/v1/streaming`)。Elk を含む多くのクライアントは
これを使って新着を即座に反映する。

ストリーミングは本質的に「クライアントとの接続を張りっぱなしにする」ものであり、
リクエスト単位で課金され、アイドル時にインスタンスが落ちるサーバーレスの実行モデルと
根本的に相容れない。Cloud Run 上で WebSocket を維持すること自体は技術的に可能だが、
接続を維持する時間だけインスタンスが起動し続けるため、
「運用費用と管理の手間を極力まで抑える」という本プロジェクトの目的に反する。

## 決定

**ストリーミング API を実装しない。** かつ、クライアントに「非対応である」ことを正しく伝える。

- `GET /api/v1/streaming` は **404 を返す。**
- `GET /api/v2/instance` の `configuration.urls.streaming` および
  `GET /api/v1/instance` の `urls.streaming_api` は空文字にする。

## 理由

Mastodon のドキュメント(`content/en/methods/streaming.md`)は、クライアントがストリーミングの
ホストを発見する方法を2通り定義している。

1. `/api/v2/instance` の `configuration.urls.streaming` を読む
2. `GET /api/v1/streaming` に投げ、別ホストなら redirect、**同一ホストなら Not Found が返る**

仕様上「ストリーミング非対応」を表明する方法は定義されていないため、
**404 を返すのが定義済みの挙動のうち最も近い**。到達できない URL を
`configuration.urls.streaming` に置くとクライアントが接続をリトライし続ける可能性があるため、
空にする方が安全である。

ストリーミングがなくてもクライアントはポーリングにフォールバックするため、
機能が失われるのではなく更新の遅延が発生するだけである。シングルユーザーの用途では許容できる。

## 結果

- 新着の反映はクライアントのポーリング間隔に依存する。
- `POST /api/v1/push/subscription`(Web Push)も同様に提供しない。現在も 404 を返している。
- 将来どうしてもリアルタイム性が必要になった場合の選択肢としては、
  Firestore のリアルタイムリスナーを使う独自 UI か、外部のマネージド WebSocket サービスの利用があるが、
  いずれも本 ADR のスコープ外。必要になったら別 ADR で扱う。

## 参照

- `third_party/mastodon_documentation/content/en/methods/streaming.md`
- [[ADR-0004]] 自前 Web UI を作らず Mastodon 互換 API + Elk を使う
- `functions/src/mastodon/instanceInformation.ts`
