# ADR-0161: 鍵ローテーション時に keyId を更新し、配送時は actor の publicKey.id を参照する

- **Status:** Accepted
- **Date:** 2026-10-24
- **Supersedes:** [ADR-0015](0015-fix-http-signature-keyid-fragment.md)

## 背景

actor の鍵をローテーションするとき(`functions/bin/rotateActorKey.ts`、→ [ADR-0009](0009-rotate-actor-key-now.md))、
keyId が `${actorId}#main-key` のまま変わらないと、keyId をキーにして公開鍵をキャッシュする
リモートサーバー(Misskey の `ApDbResolverService#publicKeyCache`、TTL 12時間など)に古い鍵が残り続け、
新鍵で署名された配送が検証失敗で破棄される(#314、#321)。
配送を 12 時間以上止める回避策は可用性を損なうため、keyId を更新してキャッシュミスを起こさせ、
即座に新鍵を再取得させる必要がある。また、[ADR-0015](0015-fix-http-signature-keyid-fragment.md) では
`tasks.ts` に `#main-key` を直書きしたが、[ADR-0042](0042-apex-fork-responsibility-boundary.md) の
責務境界に照らすと、署名の keyId は actor オブジェクトの `publicKey.id` から動的に引くべきである。

## 決定

1. **keyId の形式と世代採番:**
   初回作成時は `${actorId}#main-key` とし、ローテーション時は既存の末尾番号を進めて
   `${actorId}#main-key-2`、`#main-key-3` のように世代番号を付与する。
2. **apex フォーク側:**
   actor から公開鍵 ID を抽出する `publicKeyIdOf(signer)` を追加する。
   認証付き GET (`requestObject`) では `systemUser` の `publicKeyIdOf` を使用する。
3. **本体側 (`tasks.ts`):**
   配送ワーカーは Firestore から取得した actor の `publicKeyIdOf(actor)` を keyId として
   `apex.deliver` に渡す(取得できない場合は従来の `${actorId}#main-key` へフォールバック)。
4. **公開鍵は単一オブジェクトを維持:**
   Misskey の `ApPersonService` は `publicKey.id` が string であることを検証するため、
   旧鍵を配列で残さず最新の鍵 1 件のみを `publicKey` として公開する。
5. **管理スクリプトの更新:**
   `functions/bin/rotateActorKey.ts` は現在の `publicKey.id` を解析し、世代を進めた新しい keyId と
   公開鍵 PEM を `actor.publicKey` に設定して更新する。

## 結果

- 鍵ローテーション後、リモートサーバーは未知の keyId を受け取るため即座に actor を取得し直し、
  配送の遅延や署名失敗なしに新しい公開鍵で検証される。
- `ADR-0015` の `#main-key` 固定値前提を解消し、鍵の世代交代に自然に追従する。

## 参照

- [[ADR-0009]] actor の秘密鍵を Phase 0 のうちにローテーションする
- [[ADR-0015]] 配送の HTTP Signature keyId に `#main-key` を付与する (Superseded)
- [[ADR-0042]] apex フォークと本体コードの責務境界
- Issue: [#321](https://github.com/hakatashi/activitypub-firebase/issues/321), [#314](https://github.com/hakatashi/activitypub-firebase/issues/314)
