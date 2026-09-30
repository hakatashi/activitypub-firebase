# ADR-0054: `jsonldContextLoader` での SSRF 防御と 4xx エラー応答

- **Status:** Accepted
- **Date:** 2026-10-01

## 背景

`functions/src/apex/pub/utils.ts` の `jsonldContextLoader` は、キャッシュにない未知の
`@context` を `jsonld.documentLoaders.node()` で取得していた。
このフェッチは inbox 受信時の署名検証より前に実行されるため、認証なしでクラウドメタデータや
内部 VPC IP などへの SSRF に悪用されるリスクがあった。
また、取得失敗時に `validators.jsonld` が 500 を返していたため、送信側インスタンスが一時障害と
判断して配送リトライを繰り返してしまう問題もあった。

## 決定

- `jsonldContextLoader` の外部コンテキスト取得を、`requestObject` ([ADR-0050](0050-ssrf-safe-request-object-in-apex.md))
  と同様の SSRF 防護を持つ自前ローダーに置き換える。
  - `assertSafeUrl` による URL・IP アドレス範囲検証。
  - `remoteFetchPolicy` (設定可能、デフォルトは `https:` のみ・`unicast` のみ) の遵守。
  - リダイレクト追跡の各ホップでの再検証 (最大 5 回)。
  - `makePinnedAgent` による検証済み IP への接続固定 (DNS rebinding 対策)。
  - レスポンスサイズ上限 (5MB) とリクエストタイムアウトの適用。
- 許可リスト制は採用しない。Pleroma 等の外部コンテキスト (`litepub` 等) との連合互換性を保つ。
- `validators.jsonld` でのコンテキスト取得失敗・JSON-LD 展開エラー時は、500 ではなく
  **400 Bad Request** を返す。クライアント起因のエラーとして送信側の不要な再送を停止させる。

## 結果

- 未知の外部コンテキストを参照する正規のインスタンスとの連合性を損なわずに SSRF を遮断できる。
- 不正な `@context` を持つリクエストが 400 で即座に恒久拒否され、再送負荷を抑止できる。
