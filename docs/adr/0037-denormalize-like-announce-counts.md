# ADR-0037: Like/Announce のカウントを `_meta` の非正規化カウンタとして持つ

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

Issue #55 の実地検証で、`mastodon-test.hakatashi.com` から dev の投稿に Like / Announce
(ブースト)を送っても、対象オブジェクトのカウントが一切更新されないことを確認した。

原因は `functions/src/activitypub.ts` の `createPost` が Note オブジェクトを
`likes` / `shares` フィールドなしで作成していること。apex (`activitypub-express`) の
inbox 側 `Like` / `Announce` 処理 (`net/activity.js` `inboxSideEffects`) は
対象オブジェクトが既に `likes` / `shares` フィールドを持っている場合にしかカウント更新処理を
行わない。

### 検討して不採用にした案: apex の likes/shares コレクション機構に乗せる

`apex.buildActivity` が行っているのと同じ方法(`idToActivityCollections` +
`buildCollection`)で Note に `likes`/`shares` の空コレクションを付与する案を最初に検討したが、
検証の結果 **apex の `likes`/`shares` ルーティングは「activity (streams コレクション)」専用に
設計されており、Note のような「object (objects コレクション)」を対象にすると壊れる**
ことが分かったため不採用にした。

- `routes.likes: '/activitypub/s/:id/likes'` の `:id` は `validators.targetActivity`
  (`net/validators.js`)が `apex.store.getActivity(id)`(= **`streams` コレクションへの
  問い合わせ**)で解決する。Note 用に独自の bare id を発行しても、`streams` に対応する
  ドキュメントが存在しなければ 404 になる。
- さらに深刻なのは、実際に Like を受信した際に apex 本体が呼ぶ
  `apex.updateCollection(likesId)` (`pub/collection.js`) が
  `store.updateActivity({id: activityIdToIRI(info.activity), likes: [...]}, false)` を
  実行し、内部で `Streams.doc(...).update(...)` を呼ぶこと。対応するドキュメントが
  `streams` に存在しない場合、Firestore の `update()` は **NOT_FOUND で例外を投げる**。
  この例外は `inboxSideEffects` の `Promise.all(toDo).catch(next)` に伝播し、
  **Like の inbox 処理そのものが失敗する**(現状の「何も起きない」より悪化する)。
- `streams` 側に取ってつけたスタブアクティビティを保存すれば経路は成立するが、
  「object の付随データのために無関係な activity ドキュメントを偽造する」ことになり、
  apex のデータモデルを歪める。

## 決定

**apex の `likes`/`shares` コレクション機構は使わず、Firestore トリガー
(`functions/src/denormalizations.ts` の `onStreamCreated`)で `_meta.likesCount` /
`_meta.sharesCount` を対象オブジェクトに直接インクリメント/デクリメントする。**

`followers_count`(`userInfos`)と同じ非正規化カウンタのパターンを `objects` コレクションの
`_meta` に対して適用する。

- `Like` ドキュメントが作成されたら、`object` が指すオブジェクトの `_meta.likesCount` を +1
- `Announce` ドキュメントが作成されたら、`object` が指すオブジェクトの `_meta.sharesCount` を +1
- `Undo` が `Like`/`Announce` を包んで届いたら、対応するカウンタを -1
  (`Undo(Follow)` の既存ロジックと同じ形)

`onStreamCreated` は Firestore の非同期トリガーであり、inbox の HTTP レスポンスとは
別プロセスで実行される。ここで例外が起きても inbox への応答(200)には影響しない
(apex の同期パイプライン内で `updateCollection` を呼ぶ場合との決定的な違い)。

**前提:** このトリガーは `Like`/`Announce` ストリームドキュメントが実際に `streams` へ
保存されて初めて発火する。apex は Like/Announce の object が(actor を持つ)アクティビティ
であることを要求し、Note のような通常オブジェクトを対象にすると 400 で拒否して保存自体を
スキップしてしまう別の問題があったため、これは [ADR-0038](0038-resolve-like-announce-object-as-plain-object.md)
で別途対応した。

## 理由

- apex 本体には手を入れず (→ [ADR-0002](0002-keep-activitypub-express.md))、
  かつ apex の activity/object のデータモデルも歪めない。
- `_meta` は「AP オブジェクトと同様に厳密なスキーマ化はしない」内部専用フィールドとして
  既に活用されている(`functions/src/meta.ts` の `ObjectMeta`)。カウンタもこの用途に合致する。
- `followers_count` と同じトリガー・パターンを再利用でき、実装・レビューコストが低い。
- 非同期トリガーであるため、対象オブジェクトの解決に失敗してもリモートへの応答には影響しない。

## 結果

- `functions/src/meta.ts` の `ObjectMeta` に `likesCount?: number` / `sharesCount?: number`
  を追加する。
- `functions/src/utils.ts` に `isAPLike` / `isAPAnnounce` 型ガードを追加する
  (`isAPFollow` と同じパターン)。
- `functions/src/denormalizations.ts` の `onStreamCreated` に
  `Like` / `Announce` / `Undo(Like)` / `Undo(Announce)` の非正規化処理を追加する。
- Like/Announce を受信すると対象オブジェクトの `_meta.likesCount` /
  `_meta.sharesCount` が増減することをテストで固定する。
- 現時点では Mastodon API の `favourites_count` / `reblogs_count` はこのカウンタを
  参照しない(`docs/known-issues.md` の「Status エンティティの値が固定値」を参照。別スコープ)。

## 参照

- [[0002-keep-activitypub-express]]
- 関連 Issue: [#55](https://github.com/hakatashi/activitypub-firebase/issues/55)
