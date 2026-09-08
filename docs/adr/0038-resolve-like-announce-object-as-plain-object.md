# ADR-0038: Like/Announce の object を Note などの通常オブジェクトとしても解決する

- **Status:** Superseded by ADR-0047
- **Date:** 2026-09-08

## 背景

Issue #55 の実地検証で、`mastodon-test.hakatashi.com` から dev の投稿への Like / Announce が
常に `400 Activity type object requried for Like activity` で拒否されることを発見した。

原因は apex (`activitypub-express`) の `net/validators.js` の設計にある。

- `Like` / `Announce` は `needsResolveActivity` に分類され、`object` は
  `apex.resolveActivity()` で解決される。`resolveActivity` はまず `store.getActivity`
  (**`streams` コレクションのみ**)を見て、無ければ HTTP で取得し直すが、
  取得結果が `apex.validateActivity()`(`id`/`type`に加えて **`actor` 配列が必須**)を
  満たさなければ `undefined` を返して捨てる。
- 続く `validators.inboxActivity` は `requiresActivityObject` に `like`/`announce` を含み、
  解決結果が `validateActivity()` を満たさなければ 400 で拒否した上、
  `res.locals.apex.activity` を `true` にする行に到達しないまま `next()` を返す。
  これにより **後続の `activity.save` も実行されず、Like/Announce は一切保存されない**。

これは apex が「Like/Announce の対象は(actor を持つ)別のアクティビティである」ことを
前提にした設計になっているためだが、Mastodon を含む実際の実装は `Like.object` /
`Announce.object` に **投稿(Note)自身の IRI** を指定してくる。Note は `attributedTo` を
持つが `actor` は持たないため、apex の想定するアクティビティ形状に一致しない。

## 決定

**`validators.activityObject` の直後・`validators.inboxActivity` の直前に薄いミドルウェア
`resolveLikeAnnounceObjectAsPlainObject` を挿入する。**

`Like` / `Announce` かつ `res.locals.apex.object` が `apex.validateActivity()` を
満たしていない場合、対象を `apex.resolveObject()` で改めて通常オブジェクトとして解決し、
成功すれば `attributedTo` を `actor` として複製したコピーに差し替える。

これにより:
- `apex.resolveObject` は `store.getObject`(**`objects` コレクション**)を正しく参照するため、
  ローカルの Note がそのまま見つかる。
- `actor` フィールドを複製するのは `apex.validateActivity()` の形状チェック
  (`id`/`type`/`actor` 配列)だけを満たすための最小限の変換であり、
  以降の処理(`inboxSideEffects` の `apex.validateOwner`)は元々 `attributedTo` も見る
  実装になっている(`pub/utils.js` `validateOwner`)ため、所有権判定への影響はない。

`functions/src/inboxPost.ts` の `inboxValidationMiddlewares` /
`inboxActivityValidator`(新設)の分割点をこのミドルウェアの挿入位置に合わせて調整する。

## 理由

- apex 本体には手を入れず(→ [ADR-0002](0002-keep-activitypub-express.md))、
  [ADR-0030](0030-inbox-redundant-delivery-detection.md) 等と同じ「前後の薄いミドルウェア」
  パターンで対応する。
- `requiresActivityObject`(`like`/`announce`/`accept`/`add`/`reject`/`remove`)は
  モジュールスコープの定数配列であり、`apex` インスタンス経由で差し替えられない
  ([ADR-0036](0036-reject-unsupported-http-signature-format-early.md)の
  `security.verifySignature` のように配列要素を丸ごと置き換える手段が使えない)。
  そのため「渡す値の形状を検証が通る形に補正する」アプローチを取った。

## 結果

- `functions/src/inboxLikeAnnounceObject.ts` を新設する。
- `functions/src/inboxPost.ts` の分割点を `validators.inboxActivity` の前に移し、
  `inboxActivityValidator` を新たにエクスポートする。
- `functions/src/activitypub.ts` の inbox パイプラインに挿入する。
- Note を対象にした Like/Announce が 400 にならず保存されることをテストで固定する
  (カウントの非正規化は [ADR-0037](0037-denormalize-like-announce-counts.md) を参照)。

## 参照

- [[0002-keep-activitypub-express]]
- [[0037-denormalize-like-announce-counts]]
- 関連 Issue: [#55](https://github.com/hakatashi/activitypub-firebase/issues/55)
