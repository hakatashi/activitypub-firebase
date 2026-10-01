# ADR-0057: RFC 9421 (HTTP Message Signatures) の inbox 署名検証への対応

- **Status:** Accepted
- **Date:** 2026-10-01

## 背景

Fediverse では従来の `draft-cavage-http-signatures` から RFC 9421 (HTTP Message Signatures) への移行が進んでいる (Mastodon v4.5 以降等)。
現状の apex フォークは draft-cavage 形式のみ対応しており、RFC 9421 形式の配送 (`Signature-Input` / `Signature: sig1=:<base64>:`) は未対応として 403 拒否されるため、将来 RFC 9421 のみに一本化したインスタンスと連合できなくなる。

## 決定

[ADR-0042](0042-apex-fork-responsibility-boundary.md) に従い、apex フォーク (`security.ts`) 内で RFC 9421 の inbox 署名検証に対応する。

- `Signature-Input` ヘッダーが存在する場合、RFC 9421 検証パスを実行する。
- `Signature-Input` からラベル・対象コンポーネント・パラメータ (`keyid`, `created`, `expires`, `alg`) をパースし、`Signature` ヘッダーの対応バイト列を取得する。
- 署名強度・整合性を検証する:
  - `@method` および (`@target-uri` または `@path` と `@authority`/`host`) が署名対象に含まれていること。
  - `created` パラメータまたは `Date` ヘッダーが指定され、許容時間枠内 (未来 1 時間、過去 13 時間) であること。
  - POST リクエストでは `content-digest` または `digest` が署名対象に含まれ、`req.rawBody` の SHA-256 値と一致すること。
- RFC 9421 規定の署名対象文字列 (signature base) を構築し、署名鍵 (`keyid`) を解決して `rsa-v1_5-sha256` / `rsa-pss-sha512` / `ed25519` で検証する。

## 理由

- HTTP 署名検証は ActivityPub 準拠ライブラリの責務であり、フォーク側で完結させることで本体側の責務汚染を防ぐ。
- 外部依存を追加せず `node:crypto` で完結できる。
- RFC 9421 のみに移行した将来のインスタンスからの配送も正常に受け入れ可能となる。

## 結果

- RFC 9421 形式の HTTP 署名付きリクエストの受信・検証が成功し、`locals.sender` に送信者 actor が設定される。
- draft-cavage 形式の署名検証も後方互換性を保ち引き続き動作する。

## 参照

- 関連 Issue: [#102](https://github.com/hakatashi/activitypub-firebase/issues/102)
- 関連 ADR: [[ADR-0042]], [[ADR-0044]], [[ADR-0056]]
- RFC 9421 (HTTP Message Signatures)
