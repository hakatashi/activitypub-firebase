# ADR-0011: テストランナーを Jest から Vitest に置き換える

- **Status:** Accepted
- **Date:** 2026-09-04

## 背景

Issue #14 でユニットテストを本格的に増やすにあたり、既存の Jest 構成を見直した。
このプロジェクトは `"type": "module"` の ESM 構成で、`ts-jest` の ESM プリセット
(`useESM: true` + `--experimental-vm-modules`)と `moduleNameMapper` による
`./x.js` → `./x` の手動マッピングでようやく動いている状態だった。
Node 実行時フラグが experimental 扱いのままなのに加え、テストの新規追加のたびに
このマッピング設定を意識する必要があり、テストを増やす作業の摩擦になっていた。

## 決定

**テストランナーを Jest から Vitest 4系に置き換える。`vite` を 7系に固定し、Vitest 5 が
既定で使う `vite` 8系(バンドラに Rolldown を使う)には上げない。**

## 理由

- Vite の esbuild ベースのトランスフォームを使うため、ESM/TypeScript を素の Node 実行時フラグや
  `moduleNameMapper` なしにネイティブに扱える。`./x.js` 拡張子の解決も追加設定不要。
- API が Jest とほぼ互換(`describe`/`test`/`expect`/`beforeEach`/`afterEach`)で、
  既存の `test/integration/*.spec.ts` の移植コストが小さい(`jest.setTimeout` を
  `vi.setConfig({testTimeout})` に置き換える程度)。
- `firebase emulators:exec` でエミュレータを起動してからテストランナーを呼ぶ既存の運用は
  そのまま流用できる。

Vitest 5(`vite` 8系)を素直に入れると、`vite` が既定でバンドラに Rolldown
(Rust 製、プラットフォームごとのネイティブバイナリを optional dependency として配る)を使う
構成になり、このマシンでは `npm ci` 直後でも
`Cannot find module '@rolldown/binding-*'` で起動できなかった(npm の optional
dependency 解決に関する既知の不具合、[npm/cli#4828](https://github.com/npm/cli/issues/4828)
系統)。`vite` を Rollup(JS 実装 + 成熟した optional dependency 運用)を使う 7系に落とすことで
回避した。

## 結果

- `functions/package.json` の `jest` / `ts-jest` / `@jest/globals` / `@types/jest` 系の
  依存を `vitest`(`^4.1.11`)と `vite`(`^7.0.0`、明示的な devDependency として固定)に
  置き換える。
- `functions/jest.config.ts` を `functions/vitest.config.ts` に置き換える。
- 新規テストは `@jest/globals` ではなく `vitest` から `describe`/`test`/`expect` 等を import する。
- npm scripts (`test` / `test:watch`) の中身は Vitest 呼び出しに変わるが、
  「エミュレータを起動してから実行する」という外側の運用は変わらない。
- Dependabot 等から `vite` 8系 / `vitest` 5系への更新提案が来たら、
  Rolldown のネイティブバイナリ問題が解消されているか確認してから採否を判断する。
  未確認のまま自動マージしない。

## 参照

- 関連 Issue: [#14](https://github.com/hakatashi/activitypub-firebase/issues/14)
- 関連コード: `functions/package.json`, `functions/vitest.config.ts`
