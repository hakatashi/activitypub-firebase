# ADR-0050: SSRF セーフな `requestObject` を apex フォークに取り込む

- **Status:** Accepted
- **Date:** 2026-09-30

## 背景

[ADR-0032](0032-ssrf-safe-remote-object-fetch.md) は、apex 本体を変更しない前提で
`apex.ts` から `apex.requestObject` をメソッドごと差し替えていた。
フォーク化([ADR-0040](0040-fork-activitypub-express.md))により前提が消え、
[ADR-0042](0042-apex-fork-responsibility-boundary.md) の基準
(「他人が素で使っても同じ修正が必要か」)では SSRF セーフな取得はフォーク側に属する。

## 決定

- `pub/federation.js` の `requestObject` を SSRF セーフな実装に置き換える
  (URL 検証、リダイレクトの各ホップでの再検証、検証済み IP への接続固定、サイズ/回数上限)。
  検証ロジックは `pub/ssrf.js` に置く。
- **デフォルトは厳格**(`https:` のみ、`unicast` アドレスのみ)。
- **「どのアドレスを内部とみなすか」は設定 `remoteFetchPolicy` で注入する。**
  `{ allowedProtocols, allowedRanges, resolveAddresses }` またはそれを返す関数
  (呼び出しごとに評価される)。`resolveAddresses` は DNS 解決の差し替え点。
- ローカル開発/テストで `http:` とループバックを許可する判断は本体側
  (`apex.ts`)が policy として渡す(運用環境の判断であり、フォークは環境変数を見ない)。
- `apex.ts` のメソッド差し替えと `security/safeRequestObject.ts` / `security/ssrf.ts` は削除する。
- ADR-0032 のうち「`apex.ts` で差し替える」部分を supersede する。

## 結果

- フォークは `firebase-functions` に依存しないまま(ロガーは `apex.logger`)。
- HTTP Signature の keyId は従来の本体実装に合わせ `${systemUser.id}#main-key` とする
  (ADR-0015)。
