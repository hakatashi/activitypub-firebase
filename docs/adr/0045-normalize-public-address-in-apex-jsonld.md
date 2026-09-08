# ADR-0045: apex フォークの JSON-LD 処理層で as:Public 宛先表現を正規化する

- **Status:** Accepted
- **Date:** 2026-09-09

## 背景

ActivityPub の公開宛先は `"as:Public"`, `"https://www.w3.org/ns/activitystreams#Public"`, `"Public"` の3通りで届きうる。
apex は `publicAddress: 'as:Public'` のみを期待しており、素の `"Public"` のまま保存されると `apex.isPublic()` が false を返していた。
[ADR-0034](0034-normalize-public-address-on-inbox.md) では本体側の回避ミドルウェア (`functions/src/inboxPublic.ts`) で対応していたが、宛先表現の解釈は ActivityPub 仕様として「相手が誰であっても答えが同じ」問題であり、[ADR-0042](0042-apex-fork-responsibility-boundary.md) に基づきフォーク側の責務である。

## 決定

**apex の `fromJSONLD` 処理内で、オブジェクトツリーの audience フィールド (`to`, `bto`, `cc`, `bcc`, `audience`) に含まれる `"Public"` および `"https://www.w3.org/ns/activitystreams#Public"` を `"as:Public"` に正規化する。**
本体側の回避ミドルウェア `functions/src/inboxPublic.ts` を削除し、[ADR-0034](0034-normalize-public-address-on-inbox.md) を supersede する。

## 理由

- [ADR-0042](0042-apex-fork-responsibility-boundary.md) の責務境界に合致する。外部入力やリモートオブジェクト解決（`requestObject` など）を含むすべての JSON-LD 処理エントリポイントで自動的に公開宛先が統一される。
- 本体側の受信パイプラインから回避ミドルウェアを撤去でき、コードベースが単純化される。
- `apex.address` や `apex.isPublic` が素の `Public` に対しても正しく機能するようになる。

## 結果

- `functions/src/apex/pub/utils.js` の `fromJSONLD` 内で宛先正規化を実行する。
- `functions/src/inboxPublic.ts` と `functions/test/unit/inboxPublic.spec.ts` を削除する。
- `functions/src/activitypub.ts` から `normalizeInboxPublic` を削除する。
- apex 単体テスト (`functions/test/unit/apex/jsonld.spec.ts`) で 3 表現の正規化を保証する。

## 参照

- [[0034-normalize-public-address-on-inbox]] (Superseded)
- [[0040-fork-activitypub-express]]
- [[0042-apex-fork-responsibility-boundary]]
- 関連 Issue: [#111](https://github.com/hakatashi/activitypub-firebase/issues/111)
