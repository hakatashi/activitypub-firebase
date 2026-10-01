# ADR-0052: apex 同梱 spec を Firestore Store の適合テストとして繋ぎ直す

- **Status:** Accepted
- **Date:** 2026-09-30

## 背景

フォーク時([ADR-0051](0051-typescript-apex-fork.md))に退避した上流 spec (計約4800行)は、
MongoDB 直結かつ Jasmine 駆動の CJS であり未実行のままだった。
これを Firestore Store (`functions/src/store.ts`) に対する適合テストとして繋ぎ直し、
Store 契約の遵守と暗黙の前提破綻を機械的に検証する網を作る(Issue #115)。

## 決定

1. **テストランナーを Vitest 4系に統合する** ([ADR-0011](0011-vitest-over-jest.md))。
   `vitest.config.ts` の対象に `test/apex-upstream/**/*.spec.js` を含め、`npm test` で一括実行する。
2. **`initApex` / `resetDb` を Firestore Store + エミュレータに差し替える。**
   `ActivitypubExpress` の初期化時に `store: new Store()` を渡し、テスト毎に Firestore
   エミュレータのドキュメントを全消去して初期状態へ復元する。
3. **上流 spec 本体の書き換えを最小化し、Jasmine 構文は Vitest 互換シムで吸収する。**
   `spyOn` (`.and.resolveTo` など)、`done.fail`、`jasmine.clock` を Vitest (`vi`) 上で
   エミュレートする helper を用意し、約4800行の spec 資産を可能な限り無改変で動かす。
4. **仕様差・アーキテクチャ差で落ちるテストは、理由を明記して skip する。**
   Cloud Tasks による非同期配送 (Store の `deliveryDequeue` スタブ、ADR-0003)、
   SSRF ポリシーなど、このプロジェクトの意図的な設計差に起因するものは理由コメントを
   付与して明示的にスキップし、テストを勝手に削除しない。

## 理由

- 4800行のテストコードを手書きで全書き換えすると移植ミスが生じやすく、
  上流コードとの対応関係も失われる。シムによる互換性確保が最も安全かつ低コスト。
- ランナーを分離せず既存の `npm test` に統合することで、CI やローカルでの実行手順が変わらない。

## 結果

- `npm --prefix functions test` で既存の統合・単体テストに加え、apex 同梱 spec が実行される。
- `nock` / `@types/nock` を devDependencies に追加する。
- スキップされたテストの理由がコード上に明記され、今後の Store 拡張の指針になる。

## 参照

- [[ADR-0011]], [[ADR-0042]], [[ADR-0051]]
- 関連 Issue: [#115](https://github.com/hakatashi/activitypub-firebase/issues/115)
