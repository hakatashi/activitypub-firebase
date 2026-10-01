# ADR-0059: ローカルオブジェクトを HTTP で取り直さず、fullReplace でも _meta を引き継ぐ

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

署名検証は、キャッシュ済みの鍵で検証に失敗すると鍵のローテーションを疑い、
`resolveObject(keyId, false, true)` で署名者を取り直す。`resolveObject` は IRI で渡された場合に
ローカル IRI かどうかを見ず、自サーバーのアクターも HTTP で取り直していた。取り直した公開表現には
`_meta` が無く、`Store#updateObject(..., fullReplace)` の `set()` がそれで丸ごと上書きするため、
`keyId` に自アクターの鍵を指定した不正署名を1回送るだけで `_meta.privateKey` が消え、
配送が全滅した(Issue #150。dev で実際に発生)。

## 決定

1. **`resolveObject` は、ローカル IRI で DB に存在するものを `refresh` 指定があっても HTTP で取り直さず、
   DB のものを返す。** 埋め込みオブジェクトで渡された場合のガード([[ADR-0053]])を IRI の経路にも揃える。
2. **`Store#updateObject` / `Store#updateActivity` の `fullReplace` でも既存の `_meta` を引き継ぐ。**
   マージ規則は `saveObject` と同じ(既存の `_meta` に、渡されたオブジェクトの `_meta` を上書きマージ)。

## 理由

- 自サーバー所有のオブジェクトは DB が正本であり、自分自身に HTTP で問い合わせて得るものは
  DB の劣化コピー(`_meta` 抜き)でしかない。鍵ローテーションの追従は外部アクターにだけ必要。
- 2 は多層防御。apex が fullReplace に渡すのは外部から取得・受信した表現(リモートの Update、
  Tombstone 化、リフレッシュ)で、いずれも `_meta` を持たない。そのまま `set()` すると、秘密鍵の他に
  非正規化カウンタ([[ADR-0037]])や `_meta.collection` も消える。`_meta` を意図的に消す呼び出しは無い。

## 結果

- 外部からの入力でローカルアクターの秘密鍵が消える経路が無くなる。
- fullReplace は読み取りを伴うトランザクションになり、書き込みが1回分重くなる。
- `_meta` のキーを fullReplace で削除したい場合は、明示的に `update` で消す必要がある。

## 参照

- 関連 ADR: [[ADR-0053]], [[ADR-0042]]
- 関連コード: `functions/src/apex/pub/object.ts`, `functions/src/apex/net/security.ts`, `functions/src/store.ts`
