# ADR-0022: activitypub-express の型定義を自前で持ち、Store は `implements` で検証する

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

`activitypub-express` は型定義を同梱せず、DefinitelyTyped にも存在しない。そのため
`functions/src/apex.ts:1` と `functions/src/store.ts:3` は `// @ts-expect-error: Not typed` で
import しており、**apex 由来の値はすべて `any` としてコードベースに流れ込む。**
`store.ts` の `any` 11箇所、`mastodon/api.ts` の `as APActor` / `as APNote` 4箇所は
いずれもこれが発生源で、個別に潰しても発生源が残る限り再発する。

さらに `Store` は `IApexStore` を継承しているが、基底クラス自体が `any` であるため、
`activitypub-express/store/interface.js` が定義する20メソッドのうち**何が未実装かを型が
一切教えてくれない。** イベントハンドラも同様で、`net/activity.js:195-196` の inbox は
`{ actor, activity, recipient, object }`、`:296-297` の outbox は `{ actor, activity, object }`
と形が違うが、両方 `message: any` のため outbox で `message.recipient` と書いても通る。

## 決定

1. **`functions/types/activitypub-express.d.ts` に自前の ambient 型定義を置き、
   `@ts-expect-error` を撤去する。** `tsconfig.json` の `include` は現在 `["src"]` だけなので
   `"types"` を追加する。
2. **型定義は実際に使っている API だけを書く。** 現状 `apex.net` / `store` / `deliver` /
   `buildActivity` / `addToOutbox` / `acceptFollow` / `createActor` / `publishUpdate` /
   `toJSONLD` / `utils` / `consts` / `target` / `systemUser` / `requestTimeout` / `js` の15程度。
   未定義のメンバーを呼べばコンパイルエラーになるが、それは必要になった時点で追記する。
3. **`Store` は `IApexStore` の継承をやめ、`implements ApexStore` にする。**
4. **apex から受け取った値のランタイム検証は行わない。** 型定義は
   `node_modules/activitypub-express` の実装を読んで書き、根拠の実装箇所をコメントに残す。
5. **`apex-inbox` / `apex-outbox` は型付きヘルパー経由で購読する。**
   `activitypub.ts:196,204` の `app as unknown as EventEmitter` はこれで不要になる。

## 理由

- apex は ADR-0010 で 4.4.1 に固定済みであり、実装が動かない前提が既に成立している。
  「実装を信頼して型を書く」ことのリスクが、pin されていない依存より格段に低い。
- ランタイム検証を入れる案は採らない。apex は AP の検証を既に自前で行っており
  (`net/validators.js`)、その出力を再検証しても防げるのは apex 自身のバグだけで、
  コストに見合わない。
- `extends` ではなく `implements` にするのが本 ADR の主目的である。継承は「動くが未実装」を
  許すが、`implements` は Store の実装漏れをコンパイル時に落とす。

## 結果

- apex を 4.4.1 から上げる際、**型定義を実装と突き合わせ直す作業が必須になる。**
  ADR-0010 の更新却下ルールと合わせて運用する。
- 型定義が実装とずれた場合、検証がないため誤った型が静かに伝播する。これは受け入れる。
- `implements` 化により Store の未実装メソッドが露見する。それらの扱いは別途 Issue で追う。

## 参照

- [[ADR-0002]], [[ADR-0010]]
- `functions/src/apex.ts`, `functions/src/store.ts`, `functions/src/activitypub.ts`
- `node_modules/activitypub-express/store/interface.js`, `.../net/activity.js`
