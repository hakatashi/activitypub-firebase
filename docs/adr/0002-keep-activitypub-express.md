# ADR-0002: activitypub-express を継続利用し、配送層のみ差し替える

- **Status:** Accepted
- **Date:** 2026-09-03

## 背景

このプロジェクトは ActivityPub プロトコル本体の実装を `activitypub-express`(以下 apex)に委譲している。
apex は常駐プロセスを前提とした設計で、配送を `setInterval` ループで回す。Cloud Functions には
常駐プロセスがないため、この点でサーバーレス化の目的と真っ向から衝突している(→ [ADR-0003](0003-delivery-via-cloud-tasks.md))。

このミスマッチを理由に「apex を捨てて自前実装すべきか」を検討した。

## 決定

**apex を継続利用する。** ただし配送(delivery)層のみを自前実装に差し替える。

## 理由

apex のコード規模は `pub/` 1127行 + `net/` 1383行。このうち差し替えたい常駐配送ループは
`pub/federation.js:92-144` の約55行、全体の2%未満にすぎない。

そして apex は `pub/*` の全関数をインスタンスに bind して公開しているため、
`apex.deliver()` / `apex.address()` を外部から直接呼べる。さらに設定オプション `offlineMode: true`
だけで内蔵ループを完全に停止できる。**つまり apex 本体に手を入れずに配送層を置き換えられる。**

自前実装した場合に失うものが大きい:

- **JSON-LD 正規化(`jsonld` 依存)** — apex のデータモデル全体(`activity.actor[0]` のような配列アクセス)
  がこれを前提としており、捨てるなら Firestore のドキュメント構造ごと書き換えになる。
- **HTTP 署名検証**(鍵取得・キャッシュ・鍵ローテ時の再取得・署名検証不能な Delete の特例)
- **inbox/outbox バリデータ 450行**
- 既存の Firestore Store 448行(このプロジェクト最大の投資)がそのまま生きる
- Pleroma 互換のための `@language` 除去など、実運用で踏んだ地雷の回避策

これらは「壊れると相互運用が静かに死ぬ」層であり、自前実装のバグは連合先でしか発現しないため
テストが極めて難しい。

## 結果

受け入れるリスクを明示しておく。

- `activitypub-express` の npm 最終更新は v4.4.2 (2024-02)。更新は緩やか。
- 依存する `request` / `request-promise-native` は deprecated。
- `http-signature` が GitHub 個人 fork の特定コミット
  (`wmurphyrd/node-http-signature#9c02eeb`)にピン留めされている。サプライチェーンリスク。
- **apex は `Move` / `alsoKnownAs` / `movedTo` を一切扱わない。** アカウント引っ越しは完全に自前実装。
- apex の inbox side effect に `Follow` のケースがない(自動 Accept は既に自前実装済み)。
- 集計(フォロワー数・投稿数)ができないため、Firestore Trigger による非正規化が必要
  (`functions/src/denormalizations.ts`)。

将来 apex がメンテナンス不能になった場合の脱出路として、`apex.deliver()` を自前の
HTTP 署名実装(WebCrypto で20〜40行)に置き換えるところから始められる状態を維持する。

## 参照

- [[ADR-0003]] 配送は Cloud Tasks で行う
- `functions/src/activitypub.ts`, `functions/src/store.ts`
- 参考実装: `third_party/minipub/src/crypto.ts`(自前 HTTP 署名)
