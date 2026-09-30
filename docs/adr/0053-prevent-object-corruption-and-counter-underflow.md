# ADR-0053: 受信処理における既存オブジェクトの上書き防止と非正規化カウンタの保護

- **Status:** Accepted
- **Date:** 2026-10-01

## 背景

Like/Announce の受信や Undo 処理の並行実行時に対象 Note の `_meta.likesCount` / `sharesCount` が
`-1` になったりフィールドが消滅する不具合が確認された(Issue #141)。
原因は、`resolveReferences` -> `resolveUnknown` がインライン展開されたローカルオブジェクトを
無条件で `store.saveObject` し、`set()` で既存の `_meta` を消滅させていたこと。
さらに消滅後のドキュメントに `FieldValue.increment(-1)` が走ることで `-1` になっていた。

## 決定

多層防御により、どのような経路でオブジェクトが参照されても `_meta` の消失および負数化を防ぐ。

1. **apex: `resolveUnknown` でローカル IRI / 既存キャッシュの再保存をスキップする**
   渡されたオブジェクトの `id` が自サーバーの IRI (`this.isLocalIRI`)、または既に Store に
   存在する場合は、キャッシュ保存 (`saveObject` / `saveActivity`) を行わず、既存の
   オブジェクトを解決して返す。
2. **Store: `saveObject` で既存ドキュメントの `_meta` を保護する**
   `saveObject` をトランザクション化し、既存ドキュメントが存在する場合はその `_meta` を引き継ぐ。
3. **denormalizations: `onStreamCreated` でカウンタを 0 未満にしない**
   カウンタの更新をトランザクション化し、デクリメント時は `Math.max(0, current - 1)` で
   0 未満へのアンダーフローを防ぐ。対象ドキュメントが存在しない場合は安全にスキップする。

## 理由

- `resolveUnknown` の修正により、そもそも無意味なローカルオブジェクトの上書きと
  不要な DB 書き込みを遮断する。
- Store 側の保護により、別経路から `saveObject` が呼ばれても `_meta` が消えない堅牢性を確保する。
- カウンタのクランプにより、異常な配送順序や重複 Undo があっても負数にならず一貫性を保つ。

## 結果

- Like/Announce/Undo の並行受信や連続取り消しでも、`_meta` の消失や `-1` への破損が発生しなくなる。
- 関連テストを拡充し、エミュレータと dev 実環境の両方で検証する。

## 参照

- [[ADR-0037]], [[ADR-0042]]
- 関連 Issue: [#141](https://github.com/hakatashi/activitypub-firebase/issues/141)
