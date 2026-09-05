# 既知の問題

2026-09-05 時点(Phase 1 完了時)の調査で確認されたもの。**推測ではなく、コードを読んで確認した事実のみを記載する。**
修正したらこのファイルから削除する(履歴は git に残る)。

## セキュリティ

### Update / Delete の同一オリジン検証がない

ActivityPub 仕様は「受信サーバーは `Update` がそのオブジェクトを変更する権限を持つことを
確認しなければならない(MUST)。最低限、`Update` とその `object` が同一オリジンであることを
確認する」と定めている。HTTP 署名の検証は apex が行うが、
**署名者のドメインと対象オブジェクトの `id` のドメインの照合は行われていない。**

### SSRF 対策がない

`Move` の `target` や `inReplyTo` などのリモート URL を無条件に fetch する経路があり、
localhost や内部 IP への到達を防ぐ検証がない。

## ActivityPub 仕様準拠

### inbox の重複排除が side effect まで届いていない (MUST)

仕様は「サーバーは inbox が返すアクティビティの重複排除を行わなければならない。
重複排除はアクティビティの `id` を比較し、既に見たものを捨てることで行わなければならない」と
定めている。shared inbox と個別 inbox への二重配送、および送信側のリトライで実際に発生する。

`functions/src/store.ts` の `saveActivity` はドキュメント ID の一致で重複を検出し、
既存なら `undefined` を返す。**ここまでは正しく動いている。** 問題はその後の apex 側にある。

`activitypub-express/net/activity.js:25-37` は `saveActivity` が falsy を返すと
`updateActivityMeta(activity, 'collection', newTarget)` を呼び、その戻り値が truthy なら
`isNewActivity = 'new collection'` を立てる。`updateActivityMeta` は成功時に**必ず**
更新後のドキュメントを返すため、**同じ inbox への重複配送でも `'new collection'` になる。**
その結果 `net/activity.js:88-91` の

```js
if (res.locals.apex.isNewActivity === false) {
  return next()
}
```

は到達しないデッドコードで、`inboxSideEffects` の switch が毎回再実行される
(`update` ケースのみ `isNewActivity === true` を別途チェックしている)。

実害は `functions/src/activitypub.ts` の `apex-inbox` リスナーに出る。`Follow` を自動承認して
`Accept` を outbox に積むため、**重複配送のたびに `Accept` が相手サーバーへ再送される。**

### Inbox Forwarding (7.1.2) の動作が未検証

自分の投稿への他サーバーからの返信が、自分のフォロワーコレクションを `cc` に含む場合、
それを自分のフォロワー全員へ転送しなければならない(MUST)。
実装しないと、自分の返信だけがフォロワーに見えて相手の発言が見えない「幽霊リプライ」になる。

**apex 4.4.1 は `net/activity.js:40-67` の `forwardFromInbox` として実装を持っており、
`net/index.js:77` で `inbox.post` のミドルウェア列に組み込まれている。**
したがって「未実装」ではない。ただし転送が走るには以下の3条件をすべて満たす必要があり、
実データで満たされるかは未確認。

1. `resLocal.isNewActivity === true`(初回受信であること)
2. `resLocal.linked` にローカル IRI のオブジェクトが含まれること
3. `to` / `cc` / `audience` にこのサーバーの followers / collections コレクションが含まれること

条件1は上記「inbox の重複排除」の不具合の影響を直接受ける。

### 素の `Public` を公開宛先として認識しない

JSON-LD の compact 結果によって、公開宛先は `Public` / `as:Public` /
`https://www.w3.org/ns/activitystreams#Public` の3通りで届きうる。
仕様は3つとも受け付けるべきとしている。

実際に apex の `fromJSONLD` を通して確認した結果は次のとおり。

| 受信時の値 | `fromJSONLD` 後 | `isPublic()` |
|---|---|---|
| `as:Public` | `as:Public` | true |
| `https://www.w3.org/ns/activitystreams#Public` | `as:Public` | true |
| `Public` | `Public` | **false** |

**3通りのうち素の `Public` だけが正規化されずに落ちる。** apex の context
(`vocab/as.json:360-363`)は `Public` を `as:Public` の term として定義しているが、
compact の結果としては term 名の `Public` が残り、`pub/consts.js:17` の
`publicAddress: 'as:Public'` と一致しない。`isPublic()` が false になると
`pub/collection.js:75` のフィルタで匿名リクエストからそのアクティビティが見えなくなる。

### inbox の side effect が限定的

apex が処理するのは `Accept` / `Announce` / `Delete` / `Like` / `Reject` / `Undo` / `Update`。
`Follow` は apex 側にケースがなく、`functions/src/activitypub.ts` の `apex-inbox` リスナーで
自前実装している。`Move` は apex が完全に非対応。

## コレクションとページネーション

### `_meta.collection` がスカラーで保存され、複数コレクションに所属できない

apex は `_meta.collection` を「アクティビティが所属するコレクションの**集合**」として扱う。
MongoDB 実装 `activitypub-express/store/index.js:288-302` の `updateActivityMeta` は
`$addToSet` / `$pull` を使い、`pub/utils.js:66-71` の `hasMeta` は
`Array.isArray(obj._meta[key])` を要求し、`net/activity.js` の `undo` 処理は
`object._meta?.collection?.map(colId => ...)` と複数件の走査を前提にしている。

一方 `functions/src/store.ts` の `updateActivityMeta` は
`activityData._meta[key] = value` で**上書き**し、`remove` 時はキーごと削除する。
`normalizeActivity` が保存時に配列の先頭要素だけを残すため、
**アクティビティは常に1つのコレクションにしか所属できない。**

そのため以下が壊れる。

- `pub/activity.js:132-139` の `acceptFollow` は受信済み `Follow` に対して
  `updateActivityMeta(targetActivity, 'collection', actor.followers[0])` を呼ぶ。
  ここで `_meta.collection` が inbox の IRI から followers の IRI へ置き換わるため、
  **受理した `Follow` が inbox コレクションから消える。**
- `undo` の side effect が影響を受けた全コレクションへ `publishUndoUpdate` を出せない。
- `Reject` の `hasMeta(object, 'collection', recipient.following[0])` が成立しない。

### コレクションのページングが常に1ページ目を返す

apex は次ページのカーソルを `stream[stream.length - 1]?._id` から取得する
(`activitypub-express/pub/collection.js:72`)が、Firestore Store の `getStream` は
`doc.data()` をそのまま返すため **`_id` フィールドが存在しない。**
カーソルは常に `undefined` になり、outbox / followers などは何ページ目を要求しても
1ページ目が返る。

### `followers` が匿名リクエストに対して常に空を返す

`activitypub-express` の `getCollection`(`pub/collection.js`)は `includePrivate`
(`res.locals.apex.authorized`)が false の場合、返す前に `stream.filter(act => isPublic(act))`
で絞り込む。`authorized` はログイン中の本人リクエストのみ true になり
(`net/security.js`)、匿名の連合フェッチは常に false。一方 `Follow` アクティビティは
`to` に `as:Public` を含まないため `isPublic()` が常に false になり、
**`GET /activitypub/u/:actor/followers?page=true` への匿名アクセスは`orderedItems` が
常に空になる。**`totalItems`(`getStreamCount`)はこのフィルタを経由しないため正しい値を返す。
([Issue #20](https://github.com/hakatashi/activitypub-firebase/issues/20) の実地検証で確認)

### Undo 受信時に `followers_count` の減算が発火しない

`functions/src/denormalizations.ts` の `onStreamCreated` は `Undo` の
`object.type === 'Follow'` を見て `followers_count` を減算するが、apex の
inbox 処理(`net/activity.js` の `denormalizeObject` 対象に `undo` が含まれない)は
受信した `Undo` の `object` を文字列 IRI のまま保存し、埋め込みオブジェクトに展開しない。
そのため `object.type` は常に `undefined` で判定が成立せず、**フォロー解除時の
`followers_count` 減算は実質発火しない。**
([Issue #20](https://github.com/hakatashi/activitypub-firebase/issues/20) の実地検証で確認)

### `blockList` を渡すと `getStream` が例外を投げる

`functions/src/store.ts` の `getStream` は `blockList` が指定されると
`.where('actor', 'not-in', blockList)` を追加するが、`orderBy` は常に
`FieldPath.documentId()` のみ。Firestore は `not-in` を使う場合、最初の `orderBy` を
そのフィールド(`actor`)にすることを要求するため、この組み合わせは
`3 INVALID_ARGUMENT: order by clause cannot contain more fields after the key` で
必ず失敗する。**ブロックリスト機能は現状まったく動作しない。**
([`functions/test/unit/store.spec.ts`](../functions/test/unit/store.spec.ts) で再現を確認済み、
[Issue #31](https://github.com/hakatashi/activitypub-firebase/issues/31))

### `getStream` のカーソル方向が逆

`functions/src/store.ts:171-173` は `after` を `documentId() > after` で絞る一方、
`:192` で `documentId(), 'desc'` の降順に並べている。降順カーソルなら比較は `<` であるべき。

## Store の未実装メソッド

`findActivityByCollectionAndObjectId` と `findActivityByCollectionAndActorId` が
`functions/src/store.ts` に実装されておらず、基底クラスの `throw new Error('Not implemented')` が生きる。

`activitypub-express/net/validators.js:332,339,346` が outbox 経由の `Undo`(Follow / Block)と
`Reject` の検証で使うため、**Mastodon API からフォロー解除を実装した時点で落ちる。**

## Firestore クエリの上限

`functions/src/store.ts:86` の `getObjects` と `functions/src/mastodon/api.ts:136` の
`userIdsToAcconts` は Firestore の `in` クエリを使っているが、`in` は最大30件までしか指定できない。
フォロワーが30人を超えると破綻する。

## Mastodon API

### タイムラインが全 Note を無条件に返す

`functions/src/mastodon/api.ts` の `getAllNotes()` は `type == 'Note'` の全オブジェクトを
上限なしで取得して返す。actor フィルタも公開範囲(visibility)判定もページネーションもない。
`/v1/timelines/public`、`/v1/timelines/home`、`/v1/accounts/:id/statuses` がすべてこれを呼んでいる。

→ [ADR-0005](adr/0005-single-user-multi-ready-data-model.md)

### Status ID がランダムで時系列順にならない

`noteObjectToStatus` は Note の IRI 末尾(Firestore の自動生成 ID)を Status ID に使っている。
これはランダムなので、ID の大小比較で成立している Mastodon API のページネーションが実装できない。

→ [ADR-0006](adr/0006-mastodon-api-id-scheme.md)

### 投稿できない

`POST /api/v1/statuses` が未実装。投稿は管理者トークン付きで `/activitypub/createPost` を
手動で叩くしかない。

### 未実装ルートが 501 を返す

`functions/src/mastodon/api.ts` の末尾で未定義ルートをすべて 501 にフォールバックしている。
クライアントが起動時に叩く `custom_emojis` / `filters` / `announcements` / `lists` などが
501 を返すと、クライアントが例外を投げて起動に失敗しうる。空配列を返すスタブが必要。

### Status エンティティの値が固定値

`noteObjectToStatus` は `replies_count` / `reblogs_count` / `favourites_count` を 0 固定、
`visibility` を `'public'` 固定、`language` を `'ja'` 固定、`in_reply_to_id` を `null` 固定で返す。

### instance 情報が古い/サンプルのまま

`functions/src/mastodon/instanceInformation.ts` の `version` が `'4.0.0'` で、
Mastodon 4.3.0 で追加された `api_versions` を持たない。
`contact.account.url` が `https://mastodon.social/@Gargron` のままなど、
サンプル由来の値が残っている。

### OAuth トークンを失効できない

`functions/src/mastodon/oauth2Model.ts` の `revokeToken` が未実装で、
`POST /oauth/revoke` も 501 を返す。期限切れトークンを掃除する仕組みもない。

## その他

### actor ルートにハンドラが二重登録されている

`functions/src/activitypub.ts:99-108` で、同じ `routes.actor` に apex のハンドラと
Elk へのリダイレクトハンドラを続けて登録している。apex が `next()` を呼ばないため
後者は到達しない。ブラウザからのアクセスを Elk に飛ばす意図と思われるが機能していない。

