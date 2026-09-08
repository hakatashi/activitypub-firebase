# ADR-0040: activitypub-express をフォークし、このリポジトリで保守する

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

[ADR-0002](0002-keep-activitypub-express.md) は「apex 本体を変更せず、薄いミドルウェアで回避する」と
決めた。Phase 2 を通じて、この決定を支えていた前提が3つとも崩れた。

1. **上流追随という便益がゼロになった。** [ADR-0010](0010-pin-activitypub-express-4.4.1.md) で 4.4.1 に
   固定し「4.4.2 以降には上げない」と決めており、上流の npm 公開も 2024-02 で停止している。
   フォークのコスト(上流に追随できなくなる)は**既に支払い済み**で、
   現状維持のコスト(回避コードの保守)だけが残っている。
2. **「薄いミドルウェア」の範囲を超えた。** `functions/src/inboxPost.ts` は apex の内部ミドルウェア
   配列を `indexOf` で位置特定して `slice` している。これは公開 API ではなく実装詳細であり、
   `assert` は import 時に走るため前提が外れると Function が起動すらしない。
   inbox パイプラインは11段中7段が回避コードで、apex 本体は4つの断片に分解されている。
3. **手書き型定義が負債になった。** [ADR-0022](0022-type-definitions-for-activitypub-express.md) は
   `types/activitypub-express.d.ts` 284行について「実装とずれたら誤った型が静かに伝播する」
   リスクを明示的に受容している。加えて `http-signature` が個人リポジトリの `git+https` ピンで、
   `npm ci` の可用性が第三者のリポジトリの存続に依存している。

## 決定

**apex 4.4.1 をフォークし、このリポジトリで保守する。** npm 依存としての
`activitypub-express` は削除する。apex の不具合・実装不備は本体側の回避コードではなく
フォーク側の修正で直し、フォークは TypeScript に変換する。

[ADR-0002](0002-keep-activitypub-express.md) / [ADR-0010](0010-pin-activitypub-express-4.4.1.md) /
[ADR-0022](0022-type-definitions-for-activitypub-express.md) を supersede する。
ただし ADR-0022 のうち **`Store` を `implements` で検証する**という決定は維持する
(フォーク側の型定義に対して `implements` する形になる)。

## 理由

- ADR-0002 が挙げた「自前実装で失うもの」(JSON-LD 正規化、署名検証、バリデータ450行、
  Firestore Store 448行) は、**フォークでは何一つ失われない。** 全面再実装(選択肢3)と違い、
  データモデルも Store もそのまま生きる。
- 移行は1ステップずつ行え、`test/integration/` が HTTP レベルのテストなので
  **無改変のまま回帰の網として機能する。** 全面再実装にはこの安全網がない。
- フォークして所有権を得たあと不要な抽象を削り続けた先は事実上「自前実装」であり、
  フォークは自前実装を捨てる決定ではなく、そこへ至る唯一の安全な経路である。
- ライセンスは MIT なので取り込みに制約はない。上流の著作権表記と分岐元バージョンを記録する。

## 結果

- **署名検証と SSRF 対策の責任を自分で持つ。** ただし ADR-0032 / ADR-0036 で実質的に既に持っており、
  変わるのは「持っていることを認めるかどうか」だけである。上流に修正が出ても取り込み元がないが、
  上流は2年停止しているため実質的な変化はない。
- ADR-0030 / 0031 / 0032 / 0033 / 0034 / 0036 / 0038 が定めた**回避の手段**は無効になる。
  各 ADR が特定した**不具合そのものの分析**は引き続き有効で、フォーク側の修正の根拠になる。
- 移行の進め方は Epic [#103](https://github.com/hakatashi/activitypub-firebase/issues/103) が持つ。

## 参照

- [[ADR-0041]] フォークは in-tree に置き、モノレポ化しない
- [[ADR-0042]] apex フォークと本体コードの責務境界
- `functions/src/inboxPost.ts`, `functions/types/activitypub-express.d.ts`
