# ADR-0015: 配送の HTTP Signature keyId に `#main-key` を付与する

- **Status:** Accepted
- **Date:** 2026-09-05

## 背景

[Issue #20](https://github.com/hakatashi/activitypub-firebase/issues/20) の実地検証
(→ [`federation-testing.md`](../runbooks/federation-testing.md))で、
`mastodon-test.hakatashi.com`(本家 Mastodon)宛の `Accept` 配送が常に 401 で
`permanent_failure` になることを確認した。

`mastodon-test` 側で `ActivityPub::FetchRemoteKeyService` を直接叩いて調べたところ、
devのactorの `Keypair` は `uri: .../hakatashi#main-key` として正しく登録されているが、
`account.public_key` (legacy fallback 用) は空だった。一方、`functions/src/tasks.ts` は
`apex.deliver(actorId, body, address, privateKey)` を呼んでおり、
`activitypub-express` の `pub/federation.js:63-90` はこの `actorId` を
**そのまま** HTTP Signature の `keyId` にする。actor の公開鍵の `id` は
`pub/actor.js:37` で `${id}#main-key` なので、**送信する署名の `keyId` にはフラグメントが
付いていない。** Mastodon 側は `keyId` を鍵の URI として `keypairs.uri` に完全一致検索するため、
`#main-key` が欠けていると鍵が見つからず署名検証が必ず失敗する。

`pawoo.net` / `misskey.io` / `social.mikutter.hachune.net` 宛は同じ `keyId` で 202 が
返っており、フラグメントなしの `keyId` を許容する実装だった。本家 Mastodon の厳密な鍵解決に
よって初めて露呈したバグであり、[ADR-0014](0014-self-hosted-federation-test-instance.md) で
自前ホストの本家 Mastodon を相手に選んだ狙いが的中した形になる。

## 決定

**`functions/src/tasks.ts` の `apex.deliver` 呼び出しで、`actorId` に `#main-key` を
付与してから渡す。**

```ts
result = await apex.deliver(`${actorId}#main-key`, body, address, actor._meta.privateKey);
```

## 理由

- `activitypub-express` の `deliver()` の `actorId` 引数は `keyId` としてのみ使われる
  (`pub/federation.js:81`)。呼び出し側だけの修正で完結し、[ADR-0002](0002-keep-activitypub-express.md)
  の「apex 本体に手を入れずに配送層を差し替える」方針とも一致する。
- 鍵 ID のサフィックス `#main-key` は apex 側 (`pub/actor.js:37`) の固定値であり、
  ハードコードしても崩れない。

## 結果

- `apex.requestObject`(`pub/federation.js:19-41`、認証付き GET で `apex.systemUser.id` を
  `keyId` に使う経路)にも同じ欠陥があるが、`apex.systemUser` は `createAdmin` 実行直後の
  プロセスにしか乗らずコールドスタートで消えるため、現状は経路自体がほぼ使われない。
  今回のスコープには含めず、使う機能を実装する時に合わせて直す。

## 参照

- [[ADR-0002]] activitypub-express を継続利用し、配送層のみ差し替える
- [[ADR-0014]] 連合の検証相手として Mastodon を自前ホストする
- 関連 Issue: [#20](https://github.com/hakatashi/activitypub-firebase/issues/20)
- `functions/src/tasks.ts`, `functions/node_modules/activitypub-express/pub/federation.js`
