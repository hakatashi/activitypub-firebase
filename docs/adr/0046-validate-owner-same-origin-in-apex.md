# ADR-0046: Update / Delete の同一オリジン検証を apex フォークの validateOwner に組み込む

- **Status:** Accepted
- **Date:** 2026-09-09

## 背景

ActivityPub 仕様は `Update` / `Delete` を受信した際、署名者が対象オブジェクトを変更する権限を持つことの最低限の確認として「署名者とオブジェクトが同一オリジンであること」の検証を MUST と定めている。
apex の `validateOwner` は `object.attributedTo` / `object.actor` を署名者 ID と照合するのみでオリジンの一致を検証しておらず、インラインオブジェクトで `attributedTo` を自己申告された場合に他ドメインのオブジェクトに対する `Update` / `Delete` を許容してしまう欠陥があった。
[ADR-0031](0031-update-delete-same-origin-check.md) では本体側の回避ミドルウェア (`functions/src/inboxOriginCheck.ts`) で対応していたが、この検証は [ADR-0042](0042-apex-fork-responsibility-boundary.md) が定める「仕様が MUST とする検証」「相手が誰であっても答えが同じもの」であり、フォーク側の責務である。

## 決定

**`functions/src/apex/pub/utils.js` の `validateOwner` 内で、署名者 (`actor.id`) と対象オブジェクト (`object.id`) のオリジン (`new URL(id).origin`) が一致することを必須条件とする。**
本体側の回避ミドルウェア `functions/src/inboxOriginCheck.ts` を削除し、[ADR-0031](0031-update-delete-same-origin-check.md) を supersede する。

## 理由

- [ADR-0042](0042-apex-fork-responsibility-boundary.md) の責務境界に合致する。apex の `validateOwner` を使うすべての箇所 (`inboxActivity`、`outboxActivity`、`inboxSideEffects`、`verifyAuthorization`) で同一オリジン検証が自動的に適用される。
- 本体側の受信パイプラインから `verifySameOriginForUpdateDelete` ミドルウェアを撤去でき、コードベースが単純化される。
- 攻撃者がインラインオブジェクトの `attributedTo` を偽装しても、`object.id` のオリジンが一致しなければ `validateOwner` が確実に `false` を返し、403 で拒否される。

## 結果

- `functions/src/apex/pub/utils.js` の `validateOwner` に同一オリジン検証を追加する。
- `functions/src/inboxOriginCheck.ts` と `functions/test/unit/inboxOriginCheck.spec.ts` を削除する。
- `functions/src/activitypub.ts` の inbox パイプラインから `verifySameOriginForUpdateDelete` を削除する。
- `functions/test/unit/apex/validateOwner.spec.ts` で同一オリジン検証と所有権判定を保証する。
- `functions/test/integration/inbox-origin-check.spec.ts` が無改変で通る。

## 参照

- [[0031-update-delete-same-origin-check]] (Superseded)
- [[0040-fork-activitypub-express]]
- [[0042-apex-fork-responsibility-boundary]]
- 関連 Issue: [#109](https://github.com/hakatashi/activitypub-firebase/issues/109)
