# ADR-0018: Lint/Format を ESLint から oxlint + oxfmt に置き換える

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

このプロジェクトの実装は現在ほぼ全てコーディングエージェントが行っており、人間が直接コードに
手を加えることは殆どない。既存の ESLint 設定(`@hakatashi/eslint-config`)は 500 前後の
ルールを持つ重量級の構成で、`npm run lint` の実行時間がエージェントの1イテレーションのコストに
直結する。事前の調査で、現行設定は `typescript-eslint` の型情報を要さない
(`strictTypeChecked` 等ではない)ルールのみで構成されていることを確認しており、
型情報なしで動く高速リンタへの移行に技術的な障害がないことが分かった。

## 決定

**ESLint を oxlint(lint)+ oxfmt(format)の組み合わせに置き換える。**
ベースルールセットには `@hakatashi/oxlint-config` を使う。

## 理由

- oxlint / oxfmt は Rust 製で ESLint 比で大幅に高速。エージェントが1タスク中に何度も
  lint/format を回す運用では、この速度差が積み重なる。
- 現行ルールセットは型情報不要な構文ベースのルールのみで構成されており、
  移行に伴う検出力の低下は限定的。
- 唯一のカスタムプラグイン `eslint-plugin-private-props` の
  `no-unused-or-undeclared` ルールは oxlint/oxfmt に相当機能がなく移植不可能だが、
  実際の検出実績がなく、失っても許容できると判断した。
- `import/order`、`eslint-plugin-n` のフル機能(`no-sync` 等)も
  `@hakatashi/oxlint-config`には含まれず失われるが、同様に許容範囲と判断した。
- `@typescript-eslint/no-non-null-assertion` 相当のルールは oxlint の typescript
  プラグインに未実装。移行前に検出済みだった 19 件(うち 18 件がこのルール)は
  `node:assert` によるアサーションに書き換え、警告ゼロの状態にしてから移行した。
- oxfmt は Prettier 互換の設定(`useTabs` / `singleQuote` / `semi` / `trailingComma` /
  `quoteProps`)を持ち、既存のタブインデント・シングルクォート・セミコロンありのスタイルは
  概ね維持できる。一方 import の中括弧内スペース(`{ x }` 固定)と `interface` メンバー区切り
  (セミコロン固定)は設定不可能で、既存スタイルと非互換なため、導入時に全ファイルへの
  一括フォーマットが必要になる。

## 結果

- `functions/eslint.config.mjs` を削除し、`functions/.oxlintrc.json` と
  `functions/.oxfmtrc.json` を新設する。
- `@hakatashi/eslint-config` 系の依存(`eslint`, `typescript-eslint`,
  `eslint-plugin-*`, `@stylistic/eslint-plugin-js` 等)を `oxlint` / `oxfmt` /
  `@hakatashi/oxlint-config` に置き換える。
- `functions/package.json` の `lint` スクリプトは oxlint 呼び出しに変わり、
  新たに format 用スクリプトを追加する。
- 既存コード全体が oxfmt の出力スタイル(import の中括弧内スペースあり、
  `interface` メンバーはセミコロン区切り)に一括で書き換わる。
- カスタムルール `private-props/no-unused-or-undeclared` によるチェックは失われる。
  再発したら別途検討する。

## 参照

- 関連コード: `functions/eslint.config.mjs`, `functions/.oxlintrc.json`,
  `functions/.oxfmtrc.json`, `functions/package.json`
