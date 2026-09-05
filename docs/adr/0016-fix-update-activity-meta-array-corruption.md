# ADR-0016: `updateActivityMeta` の `_meta.collection` 破損を修正する

- **Status:** Accepted
- **Date:** 2026-09-05

## 背景

[Issue #20](https://github.com/hakatashi/activitypub-firebase/issues/20) の実地検証中、
[ADR-0015](0015-fix-http-signature-keyid-fragment.md) の修正で `Accept` が届くように
なった後も、`mastodon-test.hakatashi.com` からの新規フォローに投稿が配送されないことを
確認した。

原因は `functions/src/store.ts` の `updateActivityMeta` にあった。

```ts
transaction.update(activityRef, this.normalizeActivity(activityData));
return this.denormalizeActivity(activityData);
```

`normalizeActivity` は `_meta.collection` を配列から文字列に**破壊的に**変換し、
`denormalizeActivity` はその逆(文字列から配列)を**同じ `activityData` オブジェクトに対して**
行う。Firestore Admin SDK の `Transaction.update()` は呼び出し時に即座にシリアライズせず、
コミット時まで渡されたオブジェクトの参照を保持する。そのため、`return` 文で
`denormalizeActivity` が `activityData` を配列形式に戻した**後**にトランザクションが
コミットされ、Firestore には文字列ではなく配列が書き込まれていた。

`_meta.collection` が配列で保存されると、`getStream` / `getStreamCount`
(`_meta.collection` との文字列完全一致クエリ)が一切ヒットせず、新規フォロワーへの
配送・`/followers` の `totalItems` 計算が静かに壊れる。Cloud Logging の
`saveActivity` ログ(`_meta.collection: ["…/inbox"]`)で保存直後の値が配列だったことを
確認し、上記の変異順序が原因と特定した。

## 決定

**`transaction.update` に渡す前に `structuredClone` でスナップショットを取り、
以降の変異から独立させる。**

```ts
const normalized = structuredClone(this.normalizeActivity(activityData));
transaction.update(activityRef, normalized);
return this.denormalizeActivity(activityData);
```

## 理由

- `normalizeActivity` / `denormalizeActivity` を「引数を書き換えて返す」設計のまま残せる
  (呼び出し箇所が多く、非破壊化への全面書き換えはリスクが大きい)。
- `structuredClone` は Node.js 標準 API で追加依存が要らない。

## 結果

- 過去にこのバグで `_meta.collection` が配列のまま保存された既存の `streams` ドキュメントは
  自動修復されない。手動での補正、または `functions/bin/denormalizations.ts` 相当の
  一括修正が別途必要(今回は Issue #20 の検証中に手動で補正した)。
- `updateObject`(`store.ts` 内の別メソッド)にも `normalizeActivity` → 別処理という
  似た形はあるが、`denormalizeActivity` を同一オブジェクトに適用し直す箇所ではないため
  今回のスコープには含めない。

## 参照

- [[ADR-0015]] 配送の HTTP Signature keyId に `#main-key` を付与する
- 関連 Issue: [#20](https://github.com/hakatashi/activitypub-firebase/issues/20)
- `functions/src/store.ts`
