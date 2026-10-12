# ADR-0123: inbox の Undo(Follow) で対象アクティビティを actor と collection から解決する

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

Misskey はフォロー解除時に `Undo(Follow)` を配送するが、そのインライン `Follow` の `id` は
`${url}/follows/${follower.id}/${followee.id}` という合成 IRI であり、フォロー要求時の
`id` (`${url}/follows/${followRequestId}`) と一致しない。

apex の inbox は `needsLocalActivity = ['undo']` により `object.id` で `store.getActivity`
を引いていたため、Misskey からの Undo で既存の Follow が見つからず、フォローが解除されない不具合があった。

## 決定

**inbox の `Undo` 処理で、`getActivity` で対象が見つからず対象が `Follow` である場合は、
受信者の `followers` コレクションと送信者の `actorId` から `findActivityByCollectionAndActorId` で
既存の Follow アクティビティを解決する。**

- apex フォーク内の `functions/src/apex/net/validators.ts` で処理する。
- `resLocal.object` が未解決の場合、受信者の `followers` コレクション内に存在する送信者の
  Follow アクティビティを検索し、存在すればそれを `resLocal.object` に設定する。

## 理由

- W3C AP 仕様 §7.5 では「Undo の副作用を取り消す」ことが要求されており、Follow の解除は
  送信者と受信者の関係を解消することに本質がある。Mastodon 本体の実装でも、Follow ID ではなく
  送信者・受信者のアカウント関係から解除している。
- すでに Store には `findActivityByCollectionAndActorId` が実装されており、outbox 側でも
  同様のフォールバック検索が行われている。
- apex フォーク内で完結し、Misskey のような外部実装の ID 非互換性を安全に吸収できる。

## 結果

- Misskey からのフォロー解除が正常に処理され、followers コレクションおよび射影から削除される。
- Undo 時に ID 不一致の場合に1回の追加クエリが発生するが、Undo の頻度から見て負荷は軽微。

## 参照

- 関連 Issue: [#264](https://github.com/hakatashi/activitypub-firebase/issues/264)
- 関連 ADR: [ADR-0042](0042-apex-fork-responsibility-boundary.md)
