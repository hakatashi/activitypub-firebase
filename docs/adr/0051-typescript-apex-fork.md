# ADR-0051: apex フォークを TypeScript / ESM 化し、型を実装から導出する

- **Status:** Accepted
- **Date:** 2026-09-30

## 背景

フォーク([ADR-0040](0040-fork-activitypub-express.md))後も apex は CommonJS の JS のままで、
型は手書きの `index.d.ts` / `store/interface.d.ts` / `types/activitypub-express.d.ts` が与えていた。
[ADR-0022](0022-type-definitions-for-activitypub-express.md) が受容した「型が実装とずれても検出されない」
リスクがそのまま残っており、ビルドも `lib/apex/package.json` (CJS スコープ宣言) と `vocab/` のコピーに依存していた。

## 決定

1. **apex を ESM の TypeScript に書き換え、手書きの `.d.ts` をすべて削除する。**
   `allowJs` と `build` の `cp` を外し、`vocab/*.json` は JSON import で読む。
2. **`Apex` 型は実装から導出する。** `pub/*` の各関数は `this: Apex` を取り、
   `Apex` は「`index.ts` が設定から組み立てるプロパティ」と
   「`pub` の各関数から `this` を外したもの」の合成として定義する。
   `APObject` は `activitypub-types` を継承せず、正規化後 (`compactArrays: false`) の形だけを表す。
3. **`Apex` は Store の型で総称化する (`Apex<S extends ApexStore>`)。**
   本体固有の Store メソッド (`getFailedDeliveries` など) はフォークの契約から外し、
   本体は `apex.store` を自分の `Store` 型として受け取る。
   `_meta` の本体固有キーは本体側 (`src/meta.ts`) から `ObjectMeta` を module augmentation で拡張する。
4. **型アサーションは `src/apex/` 内でも境界に閉じ込める** ([ADR-0026](0026-ban-any-and-confine-casts-to-boundaries.md) の延長)。
   許すのは (a) `pub/utils.ts` の JSON-LD ライブラリとの境界 (`fromJSONLD` / `toJSONLD` /
   コンテキストローダ。出力の形はコンテキストが決め、型では表せない)、
   (b) `index.ts` での pub 関数の束縛、の2箇所だけ。
   AP オブジェクトのプロパティは `unknown` として読み、型ガードと正規化ヘルパーで絞る。
5. **フォークにも本体と同じ lint / format を適用する。** 上流の `standard` スタイルは捨てる。
   位置引数の公開 API は上流のまま保つため、`max-params` だけは `src/apex/` で無効にする。
6. 上流同梱の jasmine spec (`src/apex/spec/`) は MongoDB 直結の CJS で現状実行されていないため、
   `functions/test/apex-upstream/` に無改変で移し、繋ぎ直しは Issue #115 に委ねる。

## 理由

- 型が実装から出るので、ADR-0022 が受容したリスクのクラスごと消える。
- 束縛 (`for (prop in pub) apex[prop] = pub[prop].bind(apex)`) は上流の構造であり、
  クラスへの書き換えより差分が追いやすい。束縛の型付けに必要なキャストは1箇所で済む。
- Store を総称化すれば、本体固有のメソッドをフォークの型に書き込む必要がなくなり、
  [ADR-0042](0042-apex-fork-responsibility-boundary.md) の境界が型の上でも保たれる。

## 結果

- `lib/apex/` は `tsc` の出力だけで完結し、デプロイ物から spec が消える。
- 上流 4.4.1 とのソース差分は大きくなる。上流への追随は ADR-0040 で既に放棄している。

## 参照

- [[ADR-0022]], [[ADR-0026]], [[ADR-0040]], [[ADR-0041]], [[ADR-0042]], Issue #114
