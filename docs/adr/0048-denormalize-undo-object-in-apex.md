# ADR-0048: Undo の object を apex フォークの activity.save で denormalizeObject 対象に含める

- **Status:** Accepted
- **Date:** 2026-09-09

## 背景

受信した Undo アクティビティの `object` は、Mastodon では Follow 等のアクティビティが丸ごと埋め込まれるが、他の実装では文字列 IRI のみで送信される場合がある。
apex の `net/activity.js` の `activity.save` は `['create', 'announce', 'like', 'add', 'reject']` のみを `denormalizeObject` 対象としており、`undo` が含まれていなかったため、文字列 IRI のまま保存され、`followers_count` 等の減算トリガーが成立しなかった。
[ADR-0033](0033-denormalize-undo-object.md) では本体側の回避ミドルウェア `inboxUndo.ts` を挿入して対応していたが、Undo の `object` を解決済みオブジェクトとして正規化・保存することは、[ADR-0042](0042-apex-fork-responsibility-boundary.md) が定める「相手が誰であっても答えが同じもの」であり、フォーク側の責務である。

## 決定

**`functions/src/apex/net/activity.js` の `save` における `denormalizeObject` 対象に `undo` を追加し、`res.locals.apex.object` が存在する場合に `object` を埋め込んで保存する。**
本体側の回避ミドルウェア `inboxUndo.ts` を削除し、[ADR-0033](0033-denormalize-undo-object.md) を supersede する。

## 理由

- [ADR-0042](0042-apex-fork-responsibility-boundary.md) の責務境界に合致する。apex を素で使うあらゆる実装において、Undo の対象アクティビティが解決済みである場合に保存時に denormalize されるのは一貫した振る舞いである。
- これにより `inboxUndo.ts` によるミドルウェアチェーンへの事前介入が不要になり、受信パイプラインが簡素化される。
- 未解決 (対象が存在しない) の Undo では埋め込みを行わないため、安全性が維持される。

## 結果

- `functions/src/apex/net/activity.js` の `denormalizeObject` に `'undo'` を追加し、`resLocal.object` が存在する場合に denormalize 処理を行うよう変更する。
- `functions/src/inboxUndo.ts` および `functions/test/unit/inboxUndo.spec.ts` を削除する。
- `functions/src/activitypub.ts` の受信パイプラインから `denormalizeUndoObject` を撤去する。
- `functions/test/integration/inbox-undo.spec.ts` が無改変で通る。
- `functions/test/unit/apex/activity.spec.ts` を新設し、Undo の保存時 denormalize 挙動を単体テストする。

## 参照

- [[0033-denormalize-undo-object]] (Superseded)
- [[0040-fork-activitypub-express]]
- [[0042-apex-fork-responsibility-boundary]]
- 関連 Issue: [#112](https://github.com/hakatashi/activitypub-firebase/issues/112), [#53](https://github.com/hakatashi/activitypub-firebase/issues/53)
