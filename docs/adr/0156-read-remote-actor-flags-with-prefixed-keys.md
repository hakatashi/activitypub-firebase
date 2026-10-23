# ADR-0156: リモート actor の locked / bot / discoverable は、プレフィックス付きのキーも読んで Account に反映する

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

リモートの actor の `manuallyApprovesFollowers` と type `Service` / `Application` が、Mastodon API の Account の `locked` / `bot` に反映されていなかった (#382)。presenter はリモート向けに `locked: false`・`bot: false` を固定で返していた。

調べると、値を読むだけでは足りないことがわかった。apex は受け取った JSON-LD を自前の context で compact して保存する。Mastodon は `manuallyApprovesFollowers` を `as:manuallyApprovesFollowers`、`discoverable` を `toot:discoverable` と定義するが、apex の context にはどちらの語もない。そのため、リモートの actor は `as:manuallyApprovesFollowers: [true]`・`toot:discoverable: [true]` というキーで保存される。一方、ローカルの actor は API から書いたプレフィックスなしのキー(`manuallyApprovesFollowers`)で持つ。`discoverable` もリモートでは常に `false` になっていた。

## 決定

1. actor の `manuallyApprovesFollowers` / `discoverable` は、プレフィックスなしとプレフィックス付き(`as:` / `toot:`)の両方のキーを読む。値は配列でも単一値でもよい。読み取りは `utils.ts` の `isActorLocked` / `isActorDiscoverable` にまとめる。
2. Mastodon と同じく、type に `Service` か `Application` を含む actor をボットとみなす(`isAutomatedActor`)。
3. リモートの Account の `locked` / `bot` / `discoverable` はこれらから作る。ローカルは従来どおり `userInfos` の値を使う。
4. フォロー時の Relationship(`following` / `requested`)の判定も `isActorLocked` を使う。

apex の context に語を足す案は採らない。外へ送る全オブジェクトの `@context` と、保存済みのオブジェクトの読み方が変わり、連合への影響を確かめる範囲が大きいため。

## 結果

- 保存済みのリモート actor にも、データを書き換えずにそのまま反映される。
- 同じ問題を持つ語(Mastodon 拡張で context に無いもの)を新たに読むときは、同じくプレフィックス付きのキーも読む必要がある。

## 参照

- 関連 ADR: [[0025-normalize-ap-objects-instead-of-casting]]、[[0104-remote-actor-counts-via-background-refresh]]
- Mastodon: `app/services/activitypub/process_account_service.rb`、`app/models/account.rb`(`bot?`)
