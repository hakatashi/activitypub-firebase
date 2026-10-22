# ADR-0141: inbox に届いた Add / Remove の副作用を行わない

- **Status:** Accepted
- **Date:** 2026-10-22

## 背景

Issue #317 で ActivityPub 仕様の S2S 部分を条文単位で照合した。§7.8 / §7.9 は、inbox に届いた `Add` / `Remove` について
「object を target のコレクションに追加・削除する(SHOULD)」としたうえで、
**target が受信サーバーの所有でないとき**と、**受信側の裁量で許可しないとき**を例外にしている。

こちらの apex フォークは inbox の `Add` / `Remove` に副作用を持たない(`functions/src/apex/net/activity.ts` の `inboxSideEffects`)。
実際に届くのは Mastodon のピン留め(target は送信者の `featured`)で、target はすべて送信者側のサーバーのコレクションである。

## 決定

1. **inbox の `Add` / `Remove` で、こちらのサーバーのコレクションを書き換えない。** リモートの actor がこちらのコレクションを変える手段は用意しない。
2. **target がリモートのコレクションの `Add` / `Remove` は、§7.8 / §7.9 の「target が受信サーバーの所有でない」例外に当たるものとして扱い、仕様上は何もしなくてよい。**
   手元のキャッシュ(リモートのピン留めの射影など)に反映するかは、機能ごとに別の ADR で決める(#318)。
3. **送信側に不正はないので、`Add` / `Remove` には 2xx を返す**([ADR-0115](0115-inbox-4xx-only-for-sender-faults.md))。
   object が Note などのアクティビティでないときに 400 を返している現状は #363 で直す。

## 理由

- シングルユーザーで、リモートの actor にこちらのコレクションを変えさせる用途がない。受け付けると、送信者の権限の検証(誰がどのコレクションを変えてよいか)を新たに作る必要がある。
- Mastodon も、target が送信者自身の `featured` 以外の `Add` / `Remove` を無視する(`third_party/mastodon/app/lib/activitypub/activity/add.rb`)。

## 結果

- `docs/activitypub-s2s-compliance.md` で §7.8 / §7.9 を「例外規定により不要」と判定する根拠になる。
- リモートのピン留めを表示する機能(#318)は、この決定の 2 の範囲で、手元のキャッシュへの反映として実装する。

## 参照

- 関連 ADR: [[0042-apex-fork-responsibility-boundary]]、[[0047-resolve-like-announce-object-in-apex]]、[[0115-inbox-4xx-only-for-sender-faults]]
- 関連 Issue: [#317](https://github.com/hakatashi/activitypub-firebase/issues/317)、[#318](https://github.com/hakatashi/activitypub-firebase/issues/318)、[#363](https://github.com/hakatashi/activitypub-firebase/issues/363)
