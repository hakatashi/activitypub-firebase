# ADR-0073: `accounts/lookup` は手元にキャッシュ済みのリモート actor を返す

- **Status:** Accepted
- **Date:** 2026-10-05

## 背景

[[ADR-0065]] で `GET /api/v1/accounts/lookup` は他ドメインの acct に 404 を返すことにした。
しかし Elk はリモートアカウントのプロフィール (`/<server>/@user@domain`) を開くとき
`lookup?acct=user@domain` で引き、404 なら `/api/v2/search`(未実装)に落ちるため、
フォロー中の相手であってもプロフィールを URL から開けなかった (Issue #65 の確認で判明)。

## 決定

- 他ドメインの acct は、`objects` にある actor のうち `preferredUsername` が一致し、
  actor の IRI のホストが acct のドメインと一致するものを返す。ID は [[ADR-0069]] の採番に従う。
- `preferredUsername` は inbox で受けた actor では配列で保存されるため、
  `==` と `array-contains` の `Filter.or` で引く([[ADR-0072]] と同じ考え方)。
- 手元にない actor を WebFinger で取りに行くことはしない。Mastodon の `lookup` も
  リモートの解決は行わず、解決は `search?resolve=true` の役割である。

## 理由

- 手元のデータだけで返せるので、サーバーレス環境でのタイムアウトや SSRF の心配がない(ADR-0064 と同じ方針)。

## 結果

- actor の IRI のホストと acct のドメインが異なるサーバー(WebFinger のドメイン委譲)は一致しない。
  必要になったら WebFinger の結果を actor に保存する形で対応する。
