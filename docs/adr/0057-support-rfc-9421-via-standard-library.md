# ADR-0057: RFC 9421 (HTTP Message Signatures) に標準ライブラリ http-message-sig で対応する

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

Fediverse では従来の `draft-cavage-http-signatures` から RFC 9421 (HTTP Message Signatures) への移行が進んでいる (Mastodon v4.5 以降等)。
現状の apex フォークは draft-cavage 形式のみ対応しており、RFC 9421 形式の配送 (`Signature-Input` / `Signature: sig1=:<base64>:`) は未対応として 403 拒絶されるため、将来 RFC 9421 のみに一本化したインスタンスと連合できなくなる。
RFC 9421 は構造化フィールド (RFC 8941) や署名ベース正規化など仕様が複雑であり、自前実装は車輪の再発明かつ脆弱性のリスクがある。

## 決定

[ADR-0042](0042-apex-fork-responsibility-boundary.md) に従い、RFC 9421 準拠ライブラリ `http-message-sig` を導入し、apex フォーク (`security.ts`) 内で RFC 9421 inbox 署名検証を行う。

- `Signature-Input` ヘッダーが存在する場合、RFC 9421 検証パスに分岐する。
- `http-message-sig` の `verifySignature` を用い、構造化フィールドのパース・署名ベース構築・ポリシー検証を委譲する。
- 署名強度・整合性を検証する:
  - `@method` および (`@target-uri` または `@path` と `@authority`/`host`) が署名対象に含まれていること。
  - POST リクエストでは `content-digest` または `digest` が署名対象に含まれ、`req.rawBody` の SHA-256 値と一致すること。
  - `created` パラメータが許容時間枠内 (未来 1 時間、過去 13 時間) であること。
- `node:crypto` を用いた Verifier を構築し、`rsa-v1_5-sha256` / `rsa-pss-sha512` / `ed25519` で検証する (`alg` 省略時は公開鍵種別から判定)。

## 理由

- RFC 9421 仕様に準拠した高品質なサードパーティライブラリ (`http-message-sig`) を活用することで、自前実装の保守コストとセキュリティリスクを最小化する。
- `http-message-sig` は依存が `structured-headers` のみで軽量、TypeScript ネイティブであり責務境界を乱さない。
- RFC 9421 のみに移行した将来のインスタンスからの配送も正常に受け入れ可能となる。

## 結果

- RFC 9421 形式のリクエストが正常に検証され、`locals.sender` に送信者 actor が設定される。
- draft-cavage 形式の署名検証も後方互換性を保ち引き続き動作する。

## 参照

- 関連 Issue: [#102](https://github.com/hakatashi/activitypub-firebase/issues/102)
- 関連 ADR: [[ADR-0042]], [[ADR-0044]], [[ADR-0056]]
- RFC 9421 (HTTP Message Signatures)
