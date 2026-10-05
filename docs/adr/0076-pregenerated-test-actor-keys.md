# ADR-0076: テスト時の Actor 鍵ペアに事前生成した固定鍵を使う

- **Status:** Accepted
- **Date:** 2026-10-06

## 背景

テストで `apex.createActor` を呼ぶたびに `node:crypto` の `generateKeyPair` で RSA-4096
の鍵ペアが実際に生成されており、テスト時間の大半を占めていた(全体約 3 分のうち 4 ファイルだけで
約 70 秒)。素数探索のため時間のばらつきも大きく、CI でテストがタイムアウトする原因にもなっていた。

## 決定

1. **本番の鍵生成ロジック (RSA-4096) は変更しない。**
2. **テスト専用の事前生成済み RSA 鍵ペア (8本) を `functions/test/fixtures/keys.ts` に配置する。**
   署名検証ロジックに鍵長依存はないため、2048-bit の事前生成鍵を採用する。テスト専用である旨を
   コードコメントに明記する。
3. **テスト実行時 (`setupFiles`) に `node:crypto` の `generateKeyPair` をモックし、
   事前生成した鍵ペアをラウンドロビンで返す。**
   同一テスト内で生成される複数 actor に異なる鍵を割り当て、署名検証の偽陽性・偽陰性を防ぐ。
4. 本番コード (`functions/src/apex/pub/actor.ts` や本体の `functions/src/apex.ts`) には
   テスト用分岐や DI オプションを追加せず、テスト環境側で閉じる。

## 理由

apex のオプションへ鍵生成関数を注入する DI 方式は、本番コードにテスト用分岐や型拡張を持ち込み、
ADR-0042 の責務境界を複雑にする。また本体の `apex` シングルトンや apex upstream テストなど
すべての初期化経路に DI を通す必要がある。
テストの `setupFiles` でモックする方式であれば本番コードを一切汚さず、本体テストと apex
upstream テストの双方に透過的に適用できる。8本のローテーションにより actor 間の鍵分離も保てる。

## 結果・未対応

- テスト実行時間が大幅に短縮され、CI のタイムアウト懸念が解消する。
- 本番の `createActor` は従来どおり RSA-4096 の鍵を動的生成する。

## 参照

- [[0042-apex-fork-responsibility-boundary]]
- 関連 Issue: [#183](https://github.com/hakatashi/activitypub-firebase/issues/183)
