# ADR-0098: 外部への GET をローカル actor の鍵で署名する

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

apex の `requestObject` は `apex.systemUser` があれば GET に HTTP Signatures で署名する。
しかし `systemUser` を設定しているのは `/activitypub/createAdmin` だけで、各 Function のインスタンスでは
常に未設定だった。そのため Authorized Fetch を有効にしたサーバー(mastodon.social など)からは
actor や投稿を取得できず 401 になり、`search?resolve=true`([[0097-search-and-resolve-remote-resources]])
やメンションの解決が失敗していた (Issue #227 の dev 検証で判明)。

## 決定

- 本体の `ensureSystemUser`(`functions/src/apex.ts`)が、ローカル actor(`_meta.privateKey` を持つもの)を
  `objects` から遅延して読み込み `apex.systemUser` に設定する。インスタンス内では1回だけ読む。
- 外部へ取りに行く直前(検索の解決、メンションの解決)に呼ぶ。
- 署名には単一ユーザー運用([[0005-single-user-multi-ready-data-model]])のローカル actor をそのまま使い、
  Mastodon のようなインスタンス actor は作らない。

## 理由

- apex のフォークには Firestore や本体のモジュールを持ち込めない([[0042-apex-fork-responsibility-boundary]])。
  「どの actor で署名するか」は本体の責務なので、本体から `systemUser` を設定する。
- ユーザーが1人なので、インスタンス actor を別に持つ利点が小さい。

## 結果

- 署名付き GET の `keyId` はローカル actor の `#main-key` になり、相手はその公開鍵を取りに来る。
- inbox の処理中に apex が行う取得(署名検証のための actor 取得など)は、まだ署名しない。
