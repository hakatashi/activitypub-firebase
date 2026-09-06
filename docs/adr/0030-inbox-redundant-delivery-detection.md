# ADR-0030: inbox の重複配送検出を、apex 本体を変更せず前後の薄いミドルウェアで行う

- **Status:** Accepted
- **Date:** 2026-09-07

## 背景

[Issue #50](https://github.com/hakatashi/activitypub-firebase/issues/50) で判明した通り、
`activitypub-express`(以下 apex)の `net/activity.js` の `save` は、既知のアクティビティが
「同じ inbox への再配送」なのか「別の inbox への初回配送」なのかを区別できない
(`Store.updateActivityMeta` が常に更新後ドキュメントを返すため、`isNewActivity` が常に
`'new collection'` になる)。この結果 `inboxSideEffects` の重複排除チェック
(`isNewActivity === false` で早期リターン)が事実上のデッドコードになり、`Follow` の
自動 Accept を含む inbox side effect が重複配送のたびに再実行される。

[ADR-0002](0002-keep-activitypub-express.md) の方針により apex 本体
(`node_modules/activitypub-express`)には手を入れない。patch-package も導入していないため、
node_modules を直接編集しても `npm ci` で消える。

## 決定

**`apex.net.inbox.post` のミドルウェア配列を、`activity.save` の前後に薄いミドルウェアを
挿入したものに差し替える。** apex 本体のコードは一切変更しない。

- `save` の直前: 今回配送されたコレクション(`activity._meta.collection[0]`、宛先 inbox の
  IRI)が、DB に保存済みの既存アクティビティの `_meta.collection` に既に含まれているかを
  調べ、`resLocal.isRedundantDelivery` に記録する。
- `save` の直後: `isRedundantDelivery` が真かつ `isNewActivity === 'new collection'` なら
  `isNewActivity` を `false` に補正する。

`isNewActivity === false` になれば、apex 本体の `inboxSideEffects` は switch 文に到達せず
`apex-inbox` イベントも発火しない。**`Follow` の自動 Accept(`activitypub.ts` の
`onApexInbox` リスナー)を含め、重複配送時の side effect は追加のコードなしに止まる。**

## 理由

- apex 本体を1行も変更せずに `isNewActivity` の誤判定だけを補正できる。差し替えるのは
  ミドルウェア配列の要素であり、`net/activity.js` の `save` 関数自体はそのまま使うため、
  `denormalizeObject`(Create/Announce/Like/Add/Reject の object 埋め込み)のロジックを
  複製するリスクもない。
- `updateActivityMeta` の戻り値契約(常に更新後ドキュメントを返す)を変える案も検討したが、
  `inboxSideEffects`/`outboxSideEffects` の他ケース(accept/announce/like/reject)がこの
  戻り値を非 null 前提で使っており(`apex.hasMeta(object, ...)` など)、契約変更は
  それらを静かに壊す恐れがあるため採らなかった。

## 結果

- 新規ファイル `functions/src/net/inboxDedup.ts` に判定ミドルウェアを実装する。
- `functions/types/activitypub-express.d.ts` の `ApexNet` に `activity.save` の型を追加する
  (差し替え対象を `indexOf` で特定するために参照が必要)。
- `activitypub.ts` は `apex.net.inbox.post` をそのまま使わず、上記で組み替えた配列を
  `app.route(routes.inbox).post(...)` に渡す。
- outbox 側(自分の投稿)は対象外。重複は外部からの配送でのみ起こりうる。

## 参照

- [[ADR-0002]] activitypub-express を継続利用し、配送層のみ差し替える
- [[ADR-0017]] `_meta.collection` を Firestore 上でも配列として保存する
- 関連 Issue: [#50](https://github.com/hakatashi/activitypub-firebase/issues/50)
- `functions/node_modules/activitypub-express/net/activity.js`
- `functions/src/net/inboxDedup.ts`, `functions/src/activitypub.ts`
