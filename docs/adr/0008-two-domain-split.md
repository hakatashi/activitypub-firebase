# ADR-0008: ActivityPub と Mastodon API を2つのドメインに分ける

- **Status:** Accepted
- **Date:** 2026-09-03(2023-07 の実装時点の判断を事後的に記録したもの)

## 背景

ユーザーのアイデンティティには `hakatashi.com` を使う。このドメインには既に個人ウェブサイトが
置かれており(`public/` サブモジュール)、ActivityPub と共用する必要がある。

一般的な ActivityPub 実装は `/@username` のような URL で、`Accept` ヘッダによる
コンテンツネゴシエーションによって HTML と Activity Streams JSON を出し分ける。
**Firebase Hosting は `Accept` ヘッダによるルーティングをサポートしていない。**

## 決定

2つのドメインと2つの Functions に分ける。

| ドメイン | Function | 役割 |
|---|---|---|
| `hakatashi.com` | `activitypub` | ActivityPub 本体。actor / inbox / outbox / webfinger / nodeinfo |
| `mastodon.hakatashi.com` | `mastodonApi` | Mastodon 互換 REST API と OAuth2 |

ActivityPub のエンドポイントは `hakatashi.com` 上で**個人サイトと衝突しないパス**に置く。

- actor: `/activitypub/u/:actor`
- object: `/activitypub/o/:id`
- activity: `/activitypub/s/:id`
- `/.well-known/**`, `/nodeinfo/**`

開発環境は `activitypub-dev.hakatashi.com` / `mastodon-dev.hakatashi.com`。

## 理由

コンテンツネゴシエーションが使えない以上、AP のエンドポイントは個人サイトと別のパスに置くしかない。
`/activitypub/` プレフィックスなら、個人サイトの既存コンテンツ
(`/document`, `/img`, `/tools` など)と将来にわたって衝突しない。

Mastodon API を別ドメインに分けたのは、`/api/**` や `/oauth/**` を `hakatashi.com` 直下に
置きたくなかったためと、CORS ヘッダの適用範囲を分離するため。

## 結果

**WebFinger の解決が1段で完結することを保証する必要がある。** これは特にアカウント引っ越しで重要になる。

Mastodon の WebFinger 解決は2段構えになっており、`subject` が問い合わせた `resource` と
一致しない場合、`subject` が示す正規のアカウント URI に対して**2回目の WebFinger 要求**を行う。
このプロジェクトは AP と Mastodon API のドメインが違うため、ここを誤ると解決に失敗する。

満たすべき条件:

- `https://hakatashi.com/.well-known/webfinger?resource=acct:hakatashi@hakatashi.com` が
  `subject: "acct:hakatashi@hakatashi.com"` を返し、**そこで完結すること。**
- `links` に `rel="self"` かつ
  `type: "application/activity+json"`(または `application/ld+json; profile="..."`)の
  リンクがあり、actor の IRI を指すこと。
- actor の `preferredUsername` が `acct:` のユーザー名部分と一致すること。

なお `mastodon.hakatashi.com` 側の `/.well-known/webfinger` は `hakatashi.com` へ
301 リダイレクトするよう `firebase.json` で設定されている。

## 参照

- `firebase.json`(hosting targets と rewrites)
- `functions/src/firebase.ts`(`domain` / `mastodonDomain` の分岐)
- `third_party/mastodon_documentation/content/en/spec/webfinger.md`
- [[ADR-0004]] 自前 Web UI を作らず Mastodon 互換 API + Elk を使う
