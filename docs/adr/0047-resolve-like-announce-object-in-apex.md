# ADR-0047: Like / Announce の object 解決を apex フォークの validators で通常オブジェクトに対応させる

- **Status:** Accepted
- **Date:** 2026-09-09

## 背景

apex の `net/validators.js` は Like / Announce の対象を「`actor` を持つ別のアクティビティ」としてしか解決・受理しない設計 (`needsResolveActivity` / `requiresActivityObject`) になっていた。
しかし Mastodon を含むほぼ全ての実装は Like / Announce の `object` に Note 等の投稿自身の IRI を指定する。Note は `attributedTo` は持つが `actor` を持たないため、apex の `validateActivity` を満たせず 400 で拒否されていた。
[ADR-0038](0038-resolve-like-announce-object-as-plain-object.md) では本体側の回避ミドルウェア `inboxLikeAnnounceObject.ts` を挿入して対応していたが、ActivityPub プロトコル層として通常の Note に対する Like / Announce を受理することは、[ADR-0042](0042-apex-fork-responsibility-boundary.md) が定める「相手が誰であっても答えが同じもの」であり、フォーク側の責務である。

## 決定

**`functions/src/apex/net/validators.js` において、`like` と `announce` を `needsResolveActivity` / `requiresActivityObject` / `obxRequiresActivityObject` から `needsResolveObject` / `requiresObject` へ移動する。**
本体側の回避ミドルウェア `inboxLikeAnnounceObject.ts` を削除し、[ADR-0038](0038-resolve-like-announce-object-as-plain-object.md) を supersede する。

## 理由

- [ADR-0042](0042-apex-fork-responsibility-boundary.md) の責務境界に合致する。apex を素で使うあらゆる実装において Like / Announce が Note を対象にするのは標準的なユースケースである。
- `apex.resolveObject` は `store.getObject` を参照して Note などの通常オブジェクトを正しく解決・キャッシュし、`validateObject` による形状検証を満たす。
- これにより `validators.activityObject` と `validators.inboxActivity` の間に回避ミドルウェアを挿入する必要がなくなり、`inboxPost.ts` のミドルウェアスプライスを簡素化できる。

## 結果

- `functions/src/apex/net/validators.js` の `needsResolveObject` / `requiresObject` に `announce` と `like` を追加し、`needsResolveActivity` / `requiresActivityObject` / `obxRequiresActivityObject` から削除する。
- `functions/src/inboxLikeAnnounceObject.ts` を削除する。
- `functions/src/inboxPost.ts` の `inboxActivityValidator` を廃止し、`inboxValidationMiddlewares` を `activity.save` の直前までに戻す。
- `functions/src/activitypub.ts` の受信パイプラインから `resolveLikeAnnounceObjectAsPlainObject` を撤去する。
- `functions/test/integration/inbox-like-announce-object.spec.ts` が無改変で通る。
- `functions/test/unit/apex/validators.spec.ts` を新設し、Like / Announce の通常オブジェクト解決を単体テストする。

## 参照

- [[0038-resolve-like-announce-object-as-plain-object]] (Superseded)
- [[0040-fork-activitypub-express]]
- [[0042-apex-fork-responsibility-boundary]]
- 関連 Issue: [#108](https://github.com/hakatashi/activitypub-firebase/issues/108)
