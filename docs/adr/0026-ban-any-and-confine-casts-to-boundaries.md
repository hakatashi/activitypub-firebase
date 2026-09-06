# ADR-0026: `any` を禁止し、型キャストを境界ファイルに閉じ込める

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

[[ADR-0022]]〜[[ADR-0025]] は `any` と `as` の**発生源**を塞ぐ決定である。しかし発生源を
塞いでも、新しいコードが再び `any` を書けば元に戻る。現状 `functions/.oxlintrc.json` は
`"typescript/no-explicit-any": "off"` を明示しており、規約を強制する仕組みが1つもない。

ここで効く手段は限られる。**oxlint は型情報を持たないため、`no-unsafe-assignment` のような
型情報依存のルールが存在しない**(→ [[ADR-0018]])。つまり `any` の侵入は「書かれた `any` を
禁止する」ことでしか止められず、型定義側で発生源を塞ぐ [[ADR-0022]]/[[ADR-0023]] が
不可欠になる。

## 決定

1. **`typescript/no-explicit-any` を `error` にする。** 既存の `any` を全て解消してから有効化する。
2. **`catch (err: any)` を禁止し、`catch (err: unknown)` + `toError()` ヘルパーに統一する。**
   現状 `postWork.ts:98,105` と `tasks.ts:69` が `any` で受けており、`strict` が有効にしている
   `useUnknownInCatchVariables` を明示的に無効化している。
3. **型アサーション(`as T`)は次のファイル・関数の中にのみ置いてよい。** それ以外の場所では
   型ガード関数か正規化ヘルパーを使う。
   - `functions/types/*.d.ts`(外部ライブラリの型定義)
   - `functions/src/schema.ts`(`CollectionReference<T>` の付与)
   - zod などの parse 関数の内部(→ [[ADR-0024]])
   `as const`、mapped type の `as` 句、import のエイリアス(`Request as OauthRequest`)は
   アサーションではないため対象外。
4. **`tsconfig.json` に `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` /
   `noImplicitOverride` を追加する。** `noImplicitOverride` は Store が apex のインターフェースを
   実装する構造([[ADR-0022]])で特に効く。

## 理由

- 「`as` を禁止する」規約は必ず例外リストを生んで形骸化する。**配置のルールにすれば、
  レビューで機械的に判定でき、キャストが増えても被害範囲が広がらない。**
- `noUncheckedIndexedAccess` は Firestore の map 型(`_meta.index.*`、ADR-0021)を扱う際に
  存在しないキーへのアクセスを検出できる。このプロジェクトでは実利がある。

## 結果

- `exactOptionalPropertyTypes` と `noUncheckedIndexedAccess` は既存コードに広くエラーを出す。
  有効化は他の ADR の実装が終わった後に、独立した変更として行う。
- 型情報依存の lint ルールは今後も使えない。型の穴は lint ではなく型定義で塞ぐ。

## 参照

- [[ADR-0018]], [[ADR-0022]], [[ADR-0023]], [[ADR-0024]], [[ADR-0025]]
- `functions/.oxlintrc.json`, `functions/tsconfig.json`,
  `functions/src/postWork.ts`, `functions/src/tasks.ts`
