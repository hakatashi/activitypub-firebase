# ADR-0170: Mastodon API と OAuth の CORS プリフライトを 2 時間キャッシュさせる

- **Status:** Accepted
- **Date:** 2026-11-05

## 背景

Issue #423。`mastodonCors` は `Access-Control-Max-Age` を返さないので、ブラウザはプリフライトの結果を
既定の 5 秒しか保持しない。Phanpy の 15 秒ごとのポーリングのたびに `OPTIONS` が飛び、本番の mastodonapi の
リクエストの約半分、課金対象時間の約 36% を占めていた(`OPTIONS` は 3ms で終わるが 100ms に切り上げて課金される)。

## 決定

1. **`mastodonCors`(`mastodonApi` / `mediaUploadApi`)と `tokenCors`(`/oauth/token`・`/oauth/revoke`)に
   `maxAge: 7200`(秒)を設定する。** 値は `functions/src/mastodon/http/cors.ts` の定数で共有する。
2. **`nodeinfoCors`(`mastodonApi` と `activityPub` の 2 つ)には設定しない。** どちらも GET のみで
   `OPTIONS` のルートを持たず、カスタムヘッダのない GET は単純リクエストなのでプリフライトが起きない。

## 理由

- 7200 秒は Chrome の上限(これより長い値は 7200 秒に切り詰められる)。Firefox は 86400 秒まで保持するが、
  主な利用環境は Chrome 系で、これ以上延ばしても `OPTIONS` はほとんど減らない。
- プリフライトの結果は (オリジン, URL) ごとに保持されるため、ポーリングの URL ごとに 2 時間に 1 回程度まで減る。
- `tokenCors` はログイン時しか使われず効果は小さいが、同じ問題を持つので揃える。

## 結果

- 許可するメソッドやヘッダ(`allowedHeaders` など)を増やしたとき、既存のブラウザには最大 2 時間反映されない。
  増やす変更を入れるときは、この遅れを念頭に置く。
- 許可を減らす方向の変更も最大 2 時間反映されないが、サーバー側の認証は別に行うので安全性には影響しない。

## 参照

- 関連 Issue: [#423](https://github.com/hakatashi/activitypub-firebase/issues/423), [#420](https://github.com/hakatashi/activitypub-firebase/issues/420)
