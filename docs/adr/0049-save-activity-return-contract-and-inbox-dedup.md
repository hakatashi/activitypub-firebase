# ADR-0049: saveActivity の戻り値契約を明示化し、重複配送検出を Store と apex 内で完結させる

- **Status:** Accepted
- **Date:** 2026-09-09

## 背景

[ADR-0030](0030-inbox-redundant-delivery-detection.md) では apex 本体を変更せず、前後ミドルウェア `inboxDedup.ts` で `isNewActivity` を補正していた。しかしこれは apex の `Store.saveActivity` の戻り値契約が曖昧であり、Firestore 実装が常に更新後オブジェクトを返していたために `isNewActivity` が常に `'new collection'` になっていた設計上の欠陥に起因する。
Store インターフェースの契約定義は [ADR-0042](0042-apex-fork-responsibility-boundary.md) が定めるフォーク側の責務である。

## 決定

**`IApexStore.saveActivity` の戻り値契約を `{ isNew: true | 'new collection' | false, activity?: APObject }` と明示的に定義し、apex の `net/activity.js` の `save` でその結果をそのまま `isNewActivity` に反映する。**
Firestore 実装 (`store.ts`) をこの契約に準拠させ、本体側の回避コード (`inboxDedup.ts` / `inboxPost.ts`) を撤去する。[ADR-0030](0030-inbox-redundant-delivery-detection.md) を supersede する。

## 理由

- [ADR-0042](0042-apex-fork-responsibility-boundary.md) の責務境界に合致する。Store 契約が明文化されることで、apex を素で使うあらゆる Store 実装で重複配送の検出が可能になる。
- 1回のトランザクション内で新規作成 / 新コレクション追加 / 完全重複の判定と更新が原子的かつ完結に行われ、前後ミドルウェアによる介入が不要になる。
- これにより `activitypub.ts` の inbox ルーティングを素の `apex.net.inbox.post` に一本化できる。

## 結果

- `functions/src/apex/store/interface.js` / `interface.d.ts` で `saveActivity` の戻り値契約を定義する。
- `functions/src/apex/net/activity.js` の `save` を契約に基づいて簡素化する。
- `functions/src/store.ts` の `saveActivity` を新契約（重複時は `isNew: false`）に準拠させる。
- `functions/src/inboxDedup.ts`, `functions/src/inboxPost.ts` および対応テストを削除する。
- `functions/test/integration/inbox-dedup.spec.ts` が無改変で通る。

## 参照

- [[0030-inbox-redundant-delivery-detection]] (Superseded)
- [[0040-fork-activitypub-express]]
- [[0042-apex-fork-responsibility-boundary]]
- 関連 Issue: [#107](https://github.com/hakatashi/activitypub-firebase/issues/107), [#50](https://github.com/hakatashi/activitypub-firebase/issues/50)
