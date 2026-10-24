# ADR-0159: inbox は署名者の恒久的な取得失敗時に 2xx で受け取って捨てる

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

受信したアクティビティの HTTP 署名を検証する際、署名者 (keyId / actor) の取得が 401 (相手がこちらをブロック等) や 404, 410 (削除・凍結済み) 等の恒久的な失敗 (4xx) になると、inbox が 500 を返し続けていた (#327)。
送信側 (Mastodon / Misskey) は 500 を一時的障害とみなして再送を繰り返す。
署名者が恒久的に取得できない場合、何度再送しても署名を検証できずアクティビティを適用できない。また 401 を返しても Mastodon は 401 を再送対象とみなすため再送が止まらない。

## 決定

1. **署名検証時の恒久的取得失敗を扱う。** 署名検証 (Draft HTTP Signature および RFC 9421) において、署名者 (keyId) の取得および鍵の再取得が `isPermanentFetchFailure` (相手の 408/429/5xx 以外の 4xx、SSRF 違反など) の場合、警告ログを出力した上で 200 OK を返して後続処理を行わず終了する (受け取って捨てる)。
2. **一時的失敗は 500 を維持する。** ネットワークエラー、タイムアウト、相手の 5xx/408/429 などの一時的障害 (`isTransientFailure`) や内部エラーは、従来どおり 500 を返して送信側に再送させる (ADR-0115 を維持)。

## 理由

- 署名者が恒久的に取れないアクティビティは署名を検証できず適用できないため、受け取って破棄することで、送信側の不要な再送ループを停止させる。
- 未キャッシュの Delete/Update や Tombstone を 200 で破棄する既存処理、および第三者オブジェクト取得失敗時の処理 (ADR-0158) と一貫する。
- 修正は apex フォーク側 (`functions/src/apex/net/security.ts`) で完結させ、責務境界 (ADR-0042) を維持する。

## 結果

ブロックされた相手からの Block や、削除・凍結済みアカウントからの Block / Follow を受信しても 500 にならず 200 OK で完了し、送信元の不要な再送が停止する。

## 参照

- 関連 Issue: [#327](https://github.com/hakatashi/activitypub-firebase/issues/327)
- 関連 ADR: [[0042-apex-fork-responsibility-boundary]], [[0115-inbox-4xx-only-for-sender-faults]], [[0158-discard-inbox-activity-on-permanent-object-fetch-failure]]
