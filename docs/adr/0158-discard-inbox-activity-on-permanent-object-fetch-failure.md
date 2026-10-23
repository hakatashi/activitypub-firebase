# ADR-0158: inbox は第三者オブジェクトの恒久的な取得失敗時に 2xx で受け取って捨てる

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

Announce や Like などのアクティビティを inbox で受信した際、対象の `object` が第三者サーバーにあり、その取得が恒久的な失敗 (401, 404, 410, SSRF 拒否など) になると、例外が伝播して inbox が 500 を返し続けていた (#322)。
送信側 (Mastodon / Misskey) は 500 を一時的障害とみなして再送を繰り返す。
送信側のアクティビティ形式や署名自体は正当であり送信側の不正ではないため、4xx (400 等) を返すと ADR-0115 の方針 (「送信側の不正が確定したときだけ 4xx を返す」) に反する。

## 決定

1. **リモート取得の恒久的失敗を分類する。** `requestObject` は、相手の非 transient なステータスコード (408/429/5xx 以外の 4xx) やレスポンスのパース失敗、サイズ超過、SSRF 違反を `PermanentFetchError` として投げる。
2. **inbox の `validators.activityObject` は、object の取得が `PermanentFetchError` (恒久的失敗) の場合、警告ログを出力した上で `status = 200` を設定し、アクティビティを保存せず後続処理をスキップして 200 OK で終了する (受け取って捨てる)。**
3. 一時的な失敗 (`TransientFetchError`: 相手の 5xx/408/429、タイムアウト、接続切断など) や Firestore 等の内部エラーは従来どおり 500 を返して送信側に再送させる (ADR-0115 を維持)。
4. `inboxActivity` および `activityObject` は `status` が既に設定されている場合は後続検証をスキップし、400 等で上書きしない。

## 理由

- Mastodon (`reject_payload!`) や Misskey (`Ignored announce target ...`) も同様に 2xx で受け取って破棄しており、再送ループを防ぎつつ送信側の配送失敗ペナルティを回避できる。
- 修正は apex フォーク側 (`functions/src/apex/`) で完結させ、責務境界 (ADR-0042) を維持する。

## 結果

対象 Note が削除・閲覧制限されているリモートのブースト (Announce) やいいね (Like) を受信しても 500 にならず 200 で完了し、送信元の不要な再送が停止する。

## 参照

- 関連 Issue: [#322](https://github.com/hakatashi/activitypub-firebase/issues/322)
- 関連 ADR: [[0042-apex-fork-responsibility-boundary]], [[0115-inbox-4xx-only-for-sender-faults]]
