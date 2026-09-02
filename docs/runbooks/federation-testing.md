# 連合(フェデレーション)の動作確認

連合の不具合はローカルでは再現しない。**実際に他のサーバーとやりとりして確認するしかない。**
この手順は dev 環境(`activitypub-dev.hakatashi.com`)を使う。

> このファイルは実際に確認を行うたびに書き足していくこと。
> 現時点では配送が未実装(Issue #6)のため、送信側の確認は行えない。

## 原則

- **本番(`hakatashi.com`)では試さない。** dev 環境を使う。
- **相手サーバーに対する操作は取り消せない。** フォロー・投稿は相手のログとキャッシュに残る。
  テスト用のアカウントを使うこと。
- リモートサーバーは actor をキャッシュする。**変更が反映されるまで最大24時間かかることがある。**
  「直したのに直らない」の多くはこれ。

## 1. actor が正しく公開されているか

```bash
# WebFinger
curl -sH 'Accept: application/jrd+json' \
  'https://activitypub-dev.hakatashi.com/.well-known/webfinger?resource=acct:hakatashi@activitypub-dev.hakatashi.com' | jq

# actor
curl -sH 'Accept: application/activity+json' \
  'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi' | jq
```

確認すること:

- WebFinger の `subject` が**問い合わせた `resource` と一致している**こと。
  一致しないと Mastodon が2回目の WebFinger 要求を行う(→ [ADR-0008](../adr/0008-two-domain-split.md))
- `links` に `rel="self"` かつ `type` が `application/activity+json` または
  `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` のものがあり、
  actor の IRI を指していること
- actor に `inbox` / `outbox` / `publicKey` / `preferredUsername` があること
- `preferredUsername` が `acct:` のユーザー名部分と一致すること
- **`application/ld+json; profile="..."` でも同じ内容が返ること**(仕様上こちらが MUST)

```bash
curl -sH 'Accept: application/ld+json; profile="https://www.w3.org/ns/activitystreams"' \
  'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi' | jq
```

## 2. nodeinfo

```bash
curl -s 'https://activitypub-dev.hakatashi.com/.well-known/nodeinfo' | jq
curl -s 'https://activitypub-dev.hakatashi.com/nodeinfo/2.0' | jq
```

## 3. リモートから検索できるか

テスト用の Mastodon アカウントから `@hakatashi@activitypub-dev.hakatashi.com` を検索し、
プロフィールが表示されることを確認する。

表示されない場合、多くは WebFinger か actor のレスポンスの問題。
リモート側のサーバーログが見られないため、**手順1を先に完全に通しておくこと。**

## 4. フォローと自動 Accept

テスト用アカウントから dev の actor をフォローする。

- [ ] 相手側の表示が「フォロー中」になる(`Accept` が届いている)
- [ ] `streams` コレクションに `Follow` と `Accept` が記録されている
- [ ] `userInfos` の `followers_count` が増えている
- [ ] followers コレクションに反映されている

```bash
curl -sH 'Accept: application/activity+json' \
  'https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi/followers' | jq
```

**「フォローリクエスト送信済み」のまま止まる場合は `Accept` が配送されていない。**

## 5. 投稿が届くか

```bash
curl -X POST 'https://activitypub-dev.hakatashi.com/activitypub/createPost' \
  -H 'Content-Type: application/json' \
  -H "X-Hakatashi-Token: $HAKATASHI_TOKEN" \
  -d '{"text": "test"}'
```

- [ ] フォロワーのホームタイムラインに表示される
- [ ] 配送の記録が残っている(Issue #18)

## 6. プロフィール更新の配信

```bash
curl -sH "X-Hakatashi-Token: $HAKATASHI_TOKEN" \
  'https://activitypub-dev.hakatashi.com/activitypub/publishProfileUpdate'
```

相手側の表示名・アイコンが更新されることを確認する。

## 7. 返信とスレッド

- [ ] 相手から dev の投稿に返信し、`inbox` に届く
- [ ] Inbox Forwarding が動いていれば、その返信が dev のフォロワーにも転送される
      (未実装。Issue #7)

## 8. フォロー解除

- [ ] 相手からフォロー解除され、`Undo` が処理されて `followers_count` が減る

## ログの確認

```bash
npm --prefix functions run logs
# または
firebase functions:log -P dev
```

現状は全リクエスト・全レスポンスが `info` で出力されているため量が多い。
`type` フィールド(`request` / `response` / `inbox` / `outbox` / `deliveryEnqueue` など)で絞る。

## トラブルシューティング

| 症状 | 疑うところ |
|---|---|
| 検索しても見つからない | WebFinger の `subject` と `links[rel=self]` |
| フォローが「リクエスト中」で止まる | `Accept` の配送(Issue #6) |
| 投稿が届かない | 配送(Issue #6)、受信者解決(`apex.address`) |
| 署名検証エラー | `req.headers.host` の上書き(`activitypub.ts`)、`Digest` ヘッダ、鍵の不一致 |
| 変更が反映されない | リモートの actor キャッシュ。最大24時間待つ |
| コレクションが1ページしか返らない | 既知の不具合。[`known-issues.md`](../known-issues.md) を参照 |
