# ADR-0115: inbox は送信側の不正が確定したときだけ 4xx を返す

- **Status:** Accepted
- **Date:** 2026-10-11

## 背景

Issue #260。Mastodon の引っ越しでフォロワーが送る `Follow` は `MigratedFollowDeliveryWorker` が配送し、
inbox が 401 / 408 / 429 以外の 4xx を返すと**再送せずに旧アカウントのフォローを解除する**
(`json_ld_helper.rb` の `response_error_unsalvageable?`)。Misskey も 429 以外の 4xx は再送しない。
一方 [ADR-0054](0054-ssrf-safe-jsonld-context-loader.md) は `@context` の取得失敗を一律 400 にしており、
`@context` の配信元の一時的な障害でもフォロワーが失われうる。

## 決定

**inbox は「同じリクエストを再送しても結果が変わらない」(送信側の不正が確定した) ときだけ 4xx を返し、
こちら側・第三者側の一時的な失敗では 5xx を返す。** 判定に迷うものは 5xx に倒す。
修正は apex フォーク側で行う ([ADR-0042](0042-apex-fork-responsibility-boundary.md))。

1. **リモート取得の失敗を分類する。** `requestObject` と `jsonldContextLoader` は、ネットワークエラー・
   タイムアウト・本文の読み取り中の切断・DNS 解決の失敗・相手の 5xx / 408 / 429 を `TransientFetchError`
   (cause の連鎖のどこかに含む例外) として投げる。SSRF 防御による拒否・それ以外の 4xx・サイズ超過・
   JSON として不正な応答は従来どおり恒久的な失敗とする。
2. **`validators.jsonld` は、例外の cause の連鎖 (jsonld.js は `details.cause` に包む) に
   `TransientFetchError` があれば 503、なければ 400 を返す。** ADR-0054 の「取得失敗は一律 400」を置き換える
   (SSRF 防御の決定は ADR-0054 のまま有効)。
3. **署名検証で、キャッシュ済みの署名者に公開鍵がなければ、403 を返す前に取り直す。** インライン
   オブジェクトから保存された鍵なしの actor キャッシュはこちら側の都合であり、送信側の不正ではない。
   取り直しに失敗したら 500 (Tombstone は取り直さない)。
4. **inbox のルートの末尾にエラーハンドラを置き、`next(err)` で渡った例外は常に 500 にする。**
   Firestore の `ABORTED` などが Express 既定のハンドラで 4xx に化けないことを保証する。
5. **`Block` / `Move` / `Update(Person)` は 2xx で受け取る。** 処理しない種別でも保存して 200 を返す。

署名時刻の許容幅 ([ADR-0056](0056-verify-digest-and-date-window-in-http-signature.md)) は変えない。
Mastodon も Misskey も再送のたびに署名し直す (`DeliveryWorker` / `DeliverProcessorService`)。
各経路の分類の一覧は Issue #260 の PR に残す。

## 結果

- 引っ越しの `Follow` が一時的な失敗で落ちても、送信側が再送し、旧アカウントのフォローは外れない。
- 恒久的に不正な `@context` は従来どおり 400 で、送信側の無駄な再送は増えない。
- 存在しないドメインの `@context` は再送の対象になるが、送信側の再送上限で止まる。

## 参照

- 関連 ADR: [[0042-apex-fork-responsibility-boundary]]、[[0054-ssrf-safe-jsonld-context-loader]]、
  [[0056-verify-digest-and-date-window-in-http-signature]]、[[0111-retry-unaccepted-follow-and-500-on-sync-failure]]
- 関連 Issue: [#260](https://github.com/hakatashi/activitypub-firebase/issues/260)、[#10](https://github.com/hakatashi/activitypub-firebase/issues/10)
- 参考実装: `third_party/mastodon/app/helpers/json_ld_helper.rb`、
  `third_party/misskey/packages/backend/src/misc/status-error.ts`
