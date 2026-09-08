# ADR-0031: Update / Delete の同一オリジン検証を、apex 本体を変更せず前段ミドルウェアで行う

- **Status:** Superseded by ADR-0046
- **Date:** 2026-09-07

## 背景

ActivityPub 仕様は「受信サーバーは `Update` / `Delete` がそのオブジェクトを変更する権限を
署名者が持つことを確認しなければならない (MUST)。最低限、活動とその `object` が同一オリジン
であることを確認する」と定めている(→ [Issue #51](https://github.com/hakatashi/activitypub-firebase/issues/51))。

`activitypub-express`(以下 apex)の `net/validators.js` の `inboxActivity` は
`update` / `delete` / `undo` に対して `apex.validateOwner(object, actor)` を通す。しかし
`Update` の `object` は攻撃者が inbox リクエストに**インラインで埋め込んだ**値であり
(`needsInlineObject` 経由でそのまま `resLocal.object` になる)、`validateOwner` が見る
`object.attributedTo` / `object.actor` 自体が攻撃者の自己申告にすぎない。攻撃者が
`object.attributedTo` を自分の actor id に一致させれば、`object.id` を任意の(第三者や
自ホストの)URL にしたまま `validateOwner` を通過できる。`Delete` はローカル DB から
object を引き直すため実害は小さいが、同じ理由で自己申告フィールドに依存しない検証を
仕様通り明示的に行う必要がある。[ADR-0002](0002-keep-activitypub-express.md) の方針により
apex 本体(`node_modules/activitypub-express`)には手を入れない。

## 決定

**`apex.net.inbox.post` のミドルウェア配列に、`validators.inboxActivity` の直後
(`activity.save` の直前)へ薄いミドルウェアを1つ挿入する。** `Update` / `Delete` について
署名者(`res.locals.apex.actor.id`)と変更対象オブジェクト(`res.locals.apex.object.id`)の
オリジン(`new URL(id).origin`)を直接比較し、不一致なら `res.locals.apex.activity = false`、
`status = 403` を設定して以降の `save` / `inboxSideEffects` をスキップさせる。
[ADR-0030](0030-inbox-redundant-delivery-detection.md) の重複配送検出ミドルウェアと同様、
参照配列の `indexOf` で挿入位置を特定し、apex 本体のコードは一切変更しない。

ローカルオブジェクトへのリモートからの `Update` / `Delete` も、オリジン不一致として
このチェックで自動的に拒否される(自ドメインの `object.id` と他ドメインの `actor.id` は
オリジンが一致しない)。

## 理由

- 自己申告フィールド(`attributedTo` / `actor`)に依存する既存の `validateOwner` とは独立に、
  HTTP 署名検証済みの `actor.id` という信頼できる値と `object.id` を直接比較するため、
  インラインオブジェクトのなりすましを防げる。
- apex 本体を1行も変更せずに済む(ADR-0002 / ADR-0030 と同じ挿入パターン)。
- `Undo` は対象外とした。`Undo` の `object` は `needsLocalActivity` によりローカル DB から
  引き直され、`activity.actor[0]` は保存時点の真の送信者であり攻撃者が自己申告できないため、
  既存の `validateOwner` で同種のなりすましは成立しない。

## 結果

- 新規ファイル `functions/src/inboxOriginCheck.ts` に検証ミドルウェアと、
  `apex.net.inbox.post` 相当の配列へ挿入するビルダー関数を実装する。
- `activitypub.ts` は `buildDedupedInboxPost()` の出力をさらにこのビルダーに通してから
  `app.route(routes.inbox).post(...)` に渡す。
- `functions/types/activitypub-express.d.ts` の `ApexNet` に、挿入位置特定に必要な
  `validators.inboxActivity` の型を追加する。

## 参照

- [[ADR-0002]] activitypub-express を継続利用し、配送層のみ差し替える
- [[ADR-0030]] inbox の重複配送検出を、apex 本体を変更せず前後の薄いミドルウェアで行う
- 関連 Issue: [#51](https://github.com/hakatashi/activitypub-firebase/issues/51)
- `functions/node_modules/activitypub-express/net/validators.js`
- `functions/src/inboxOriginCheck.ts`, `functions/src/activitypub.ts`
