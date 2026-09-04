# ADR-0013: 連合の検証相手として Mastodon を自前ホストする

- **Status:** Accepted
- **Date:** 2026-09-05

## 背景

連合の不具合はローカルでは再現せず、実在の Mastodon と疎通するしかない
([Issue #20](https://github.com/hakatashi/activitypub-firebase/issues/20))。
相手として既存の大規模インスタンス(pawoo.net、mstdn.jp)を使う案があったが、
`@hakatashi@pawoo.net` は Phase 5 の引っ越し元である([`roadmap.md`](../roadmap.md))。
検証でフォローや投稿を繰り返した結果アカウントかドメインが制限されると、引っ越し自体が詰む。

これから顕在化する不具合の中心は HTTP 署名の検証と JSON-LD の解釈であり、**相手側のログが
読めないと原因を特定できない。** リモートは actor をキャッシュするため、「初対面の WebFinger
解決」は (インスタンス × ドメイン) につき事実上1回しか試せないという制約もある。

## 決定

**検証用の Mastodon を自前でホストし、連合の確認はすべてそこを相手に行う。**

- ドメインは `mastodon-test.hakatashi.com`。ホストは自宅サーバー(HakataMatrix)で、
  既存の nginx + certbot + Docker 構成に相乗りする。
- 本家の公式イメージと `third_party/mastodon/docker-compose.yml` をそのまま使う。
- pawoo.net / mstdn.jp など他人が運用するインスタンスをテストに使わない。
- 構築と運用の手順は [`federation-testing.md`](../runbooks/federation-testing.md) に置く。

## 理由

- `tootctl domains purge` でこちらのドメインの痕跡を消せるため、**「初対面」の検証を何度でも
  やり直せる。** actor キャッシュ由来の「直したのに直らない」が消える。
- 相手側の sidekiq ログに署名検証の失敗理由がそのまま出る。follow / unfollow / 返信 /
  Undo / Delete も回数を気にせず繰り返せる。Phase 2 以降の検証でも同じ利点が効く。
- 管理者権限があるためアクセストークンを `rails runner` で発行できる。ブラウザでの OAuth 認可が
  不要になり、**検証手順全体が CLI だけで完結する**(Mastodon 4.x の `grant_types_supported` は
  `authorization_code` と `client_credentials` のみで、パスワードグラントがない)。
- GoToSocial や Akkoma は運用は軽いが、互換性のターゲットは Mastodon 本体であり、
  その厳しさを再現できない相手で通しても検証にならない。

## 結果

- 自宅サーバーの死活が検証の前提になり、ディスクとメディアキャッシュの管理が要る。
- 「大規模インスタンスで実際に見えるか」は未検証のまま残る。Phase 5 の引っ越し直前に
  pawoo.net から1回だけ確認する。
- 相手が1実装しかないため「たまたま動く」状態は検出できない。必要なら別実装を足す。

## 参照

- 関連 Issue: [#20](https://github.com/hakatashi/activitypub-firebase/issues/20)
- 参考: `third_party/mastodon/docker-compose.yml`, `third_party/mastodon/dist/nginx.conf`
