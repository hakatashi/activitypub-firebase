# ADR-0150: ボットのフォローは、ボットごとの許可リストで承認し、それ以外は Reject する

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

ボットの投稿を読むのは基本的に `@hakatashi@hakatashi.com` だけで、投稿はフォロワー限定にする予定である。
フォロワー限定の投稿は followers に届くので、誰でもフォローできると意味がない。一方で、Fediverse 全体に
公開するボットも作れるようにしたい。現状の inbox は Follow を無条件に承認する(ADR-0111)。

## 決定

1. ボットの UserInfo に `followPolicy: { mode: 'open' | 'allowlist', allowlist: string[] }` を持つ。
   作成時の既定は `allowlist` で、リストはインスタンス設定の `bots.defaultFollowAllowlist`(ADR-0148)。
   ボット用インスタンスでは本番と dev の `hakatashi` の actor IRI になる。
2. `allowlist` のボットは actor に `manuallyApprovesFollowers: true` を出す。リストにある actor からの Follow は
   承認し、それ以外には `Reject` を返して followers に入れない。
3. `open` のボットは現状どおりすべて承認し、`manuallyApprovesFollowers: false` を出す。
4. ポリシーを持たない actor(主 actor)は `open` として扱う。本アカウントの挙動は変わらない。
5. 判定は inbox の Follow の処理と、未承認の Follow の補正(`reconcilePendingFollows`)で同じ関数を使う。
6. ポリシーの変更で `manuallyApprovesFollowers` が変わったら、actor の `Update` を配送する。
   すでに承認したフォロワーは、ポリシーを変えても外さない。
7. 投稿の公開範囲はポリシーと独立に、投稿ごとに決める。`allowlist` のボットの既定の公開範囲は `private` にする。

## 理由

- 承認する UI がないので、保留にすると相手からは「承認待ち」のまま残る。Reject すれば相手のクライアントでも
  フォローできなかったことが分かる。
- 許可リストは actor の IRI で持つ。ドメイン単位にすると、同じサーバーの他人まで通ってしまう。

## 結果

- 許可リストの変更は `PATCH /activitypub/bots/:username` で行う。

## 参照

- 関連 ADR: [ADR-0111](0111-retry-unaccepted-follow-and-500-on-sync-failure.md)、[ADR-0149](0149-bot-actors-as-additional-local-actors.md)
- Mastodon の `Reject` の処理: `third_party/mastodon/app/lib/activitypub/activity/reject.rb`
