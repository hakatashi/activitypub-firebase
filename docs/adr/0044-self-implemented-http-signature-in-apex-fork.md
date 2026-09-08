# ADR-0044: HTTP 署名検証・生成を apex フォーク内に自前実装しエラーを分類する

- **Status:** Accepted
- **Date:** 2026-09-09

## 背景

[ADR-0040](0040-fork-activitypub-express.md) で apex をフォークした。
apex の HTTP 署名処理には以下の課題があった:
1. `http-signature` 依存が個人 GitHub リポジトリの `git+https` ピンで、`npm ci` の可用性が外部に依存していた。
2. `verifySignature` は全例外を単一の catch で 500 に丸め込んでいたため、クライアントの不正形式（RFC 9421 等）でも送信側が無限再送していた（[ADR-0036](0036-reject-unsupported-http-signature-format-early.md) の前段ミドルウェアで 403 に落として回避していた）。
3. GET 用の署名生成 (`computeHttpSignatureHeaders`) とフォーク側の署名生成で実装が重複していた。

## 決定

**`http-signature` 依存を削除し、draft-cavage 署名のパース・検証・生成を `node:crypto` でフォーク内に自前実装する。**

- `verifySignature` のエラーを分類する: 署名ヘッダーなしは 401、パース失敗・未対応形式・署名不一致は 403、鍵取得の通信障害等は 500。
- 回避ミドルウェア `functions/src/inboxSignature.ts` を削除し、[ADR-0036](0036-reject-unsupported-http-signature-format-early.md) を supersede する。
- 署名生成ロジック (`computeHttpSignatureHeaders`) をフォーク側に一元化し、GET/POST 双方で共通利用する。

## 理由

- [ADR-0042](0042-apex-fork-responsibility-boundary.md) の責務境界に従い、HTTP 署名の検証・生成はライブラリ（フォーク）側の純粋な責務である。
- 外部 git URL 依存を完全に排除し、ビルドの堅牢性を高める。
- 不正形式や署名検証失敗時に 403 をフォーク本体で返すことで、送信側の不要な再送を正しく抑止できる。

## 結果

- `package.json` から `http-signature` が削除される。
- 回避コード `inboxSignature.ts` が撤去され、inbox パイプラインが 1 段簡素化される。
- GET/POST 双方の署名生成がフォーク側の 1 実装に集約される。

## 参照

- [[0036-reject-unsupported-http-signature-format-early]] (Superseded)
- [[0040-fork-activitypub-express]]
- [[0042-apex-fork-responsibility-boundary]]
- 関連 Issue: [#106](https://github.com/hakatashi/activitypub-firebase/issues/106)
