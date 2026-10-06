# ADR-0079: テストと bin/ を型チェックの対象にし、PR の CI で build と typecheck を実行する

- **Status:** Accepted
- **Date:** 2026-10-06

## 背景

`functions/tsconfig.json` の `include` は `src` のみで、Vitest は型を消すだけで検査しないため、
`test/` と `bin/` は一度も型チェックされておらず、125件の型エラーが潜んでいた。
また PR の CI には `tsc` がなく、型エラーは `main` へのマージ後のデプロイ(`predeploy` の `build`)で初めて発覚していた。

## 決定

1. `tsconfig.json` を型チェック用(`noEmit`、`src` / `test/**/*.ts` / `bin/**/*.ts`)とし、
   出力用に `tsconfig.build.json`(`src` のみ、`noEmit: false`)を分ける。`build` は後者、新設の `typecheck` は前者を使う。
2. PR で走る `lint` ジョブに `build` と `typecheck` を追加する。
3. テストの `as` キャストは [[ADR-0028]] のとおり許容する。ただし型の不一致がフィクスチャの誤りを示す場合は
   キャストで黙らせず、フィクスチャを直す(例: モック store に欠けたメソッドの追加、`deliver` の戻り値に `headers` を足す)。
4. apex のオブジェクトを渡す箇所と Mastodon API 層が要求する `APActor` の両方を満たすテスト用の型として、
   `test/helpers/actor.ts` に `LocalActor`(`APObject & APActor`)を置く。

## 理由

- 型エラーを PR の時点で落とす。デプロイジョブまで持ち越さない。
- `build` の出力(`lib/`)は変えない(`src` のみを対象とする点は従来どおり)。
- `test/apex-upstream/**/*.js` は JS なので対象外。`setup.ts` は対象とし、
  上流テスト由来の `any`([[ADR-0026]])は従来どおり同ファイルに閉じ込める。
