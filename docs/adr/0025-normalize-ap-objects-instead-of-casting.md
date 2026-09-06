# ADR-0025: AP オブジェクトは正規化ヘルパーと型ガードで扱い、`as` で絞り込まない

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

`activitypub-types` の型をそのまま使っても `as` は減らない。AS2 の性質上ほぼ全プロパティが
optional かつ union(`string | APObject | (string | APObject)[]`)であり、具体的な形を仮定した
時点でキャストが要るためである。実際 `mastodon/api.ts:107,190,223,384` は
`apex.store.getObject(actorId) as Promise<APActor>` のように書かれている。

さらに apex は `compactArrays: false` で JSON-LD を正規化するため、`actor` / `object` / `type`
といったプロパティは**常に配列**になり、要素は IRI 文字列・`Link`・埋め込みオブジェクトの
いずれにもなりうる。この事実を知らずに書かれた判定は静かに壊れる。
`denormalizations.ts:47` の `objects.some((object: any) => object.type === 'Note')` は
`type` が配列で来る場合に一致せず、`object` が IRI 文字列のときは常に false になる。

`utils.ts:79` の `toIdArray` は既にこの考え方で書かれており、実績もある。

## 決定

1. **AP オブジェクトのプロパティに直接触らず、正規化ヘルパーを経由する。**
   `toIdArray` に加えて `toTypeArray` / `toStringValue` / `firstOf` を `functions/src/utils.ts`
   に揃え、AS2 の表現ゆれの吸収はここに一元化する。
2. **具体型への絞り込みは `as` ではなく型ガード関数で行う。**
   例: `const isNote = (o: APObject): o is APNote => toTypeArray(o.type).includes('Note')`。
   型ガードは正規化ヘルパーの上に書き、`type` が配列で来る事実をガードの内側に閉じ込める。
3. **`activitypub-types` は devDependencies のまま使う。** 型のみのパッケージであり、
   ランタイム依存を増やさない。

## 理由

- `as APActor` の大半は apex の戻り値が `any` であることに由来し、[[ADR-0022]] で自動的に消える。
  本 ADR が対象とするのは、型が付いた後に**新しく生えてくる**絞り込みのキャストである。
- 表現ゆれの判定を各所に散らすと必ず食い違う。既に `denormalizations.ts` と `toIdArray` で
  同じ判定の実装が2通り存在している。
- `activitypub-types` を使わずに自前の AP 型を定義する案は採らない。仕様に沿った型を
  自前で保守するコストが、union を捌くコストを上回る。

## 結果

- AP オブジェクトを触るコードは常に1段のヘルパー呼び出しを挟むことになり、素朴に書くより冗長になる。
- 既存の判定(`denormalizations.ts:47` ほか)は書き換えが必要で、挙動が変わる箇所がある。
  変更は dev 環境で連合の実地検証を伴う。

## 参照

- [[ADR-0021]], [[ADR-0022]]
- `functions/src/utils.ts`, `functions/src/denormalizations.ts`, `functions/src/mastodon/api.ts`
