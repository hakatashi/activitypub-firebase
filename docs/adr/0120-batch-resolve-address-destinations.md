# ADR-0120: 投稿時の宛先解決を getObjects と resolveObjects でバッチ化する

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

フォロワー 500 人存在時の `POST /api/v1/statuses` で、apex の `address` (`functions/src/apex/pub/activity.ts`) がフォロワーコレクションの全 actor を 1 件ずつ `resolveObject` (`Store#getObject`) で読んでいた。Firestore への個別読み取り RPC がフォロワー数分発生し、応答に約 13 秒を要していた (Issue #286)。引っ越し後はフォロワーが増えるため、投稿のたびにこの時間がかかる。

## 決定

1. **`ApexStore` に `getObjects` を追加:** `IApexStore` に `getObjects(ids: string[], includeMeta?: boolean): Promise<APObject[]>` を定義する。基底実装は `Promise.all` + `getObject` のフォールバックとする。
2. **Firestore Store での一括取得:** `Store#getObjects` を override し、`this.db.getAll` (BatchGetDocuments) で一括取得する。重複 ID は dedupe し、存在しないドキュメントは除外する。既存の `store/objects.ts` の `getObjects` も `db.getAll` に統一して高速化する。
3. **apex に `resolveObjects` を追加:** `resolveObjects(items: unknown[]): Promise<(APObject | undefined)[]>` を実装する。ID 群を抽出して `store.getObjects` でローカルキャッシュを一括取得し、見つかったものは即座に返し、未解決のものだけ個別に `resolveObject` (リモート fetch 等) にフォールバックする。
4. **`address` でのバッチ解決:** `address` でフォロワーなどのコレクションを展開したアイテム ID 群を、個別の `resolveObject` ループではなく `resolveObjects` で一括解決する。

## 理由

- ADR-0042 の判定基準「他人が同じライブラリを素で使ったときも同じ修正を必要とするか」に合致する。コレクション要素の解決や Store 契約は ActivityPub エンジン側の責務であり、相手が誰であっても必要な最適化。
- Firestore の `getAll` は単一のストリーミング RPC で完結するため、500 人の解決が 500 RPC から 1 RPC に減少し、応答時間が数秒〜十数秒から数百ミリ秒程度に劇的に短縮される。
- 新たなデータ構造やバックフィルが不要で、既存のフォロワーデータをそのまま扱える。

## 結果

- フォロワー 500 人規模での宛先解決に伴う Firestore RPC 数と待機時間が激減し、投稿 API のレイテンシが改善する。
- キャッシュにないオブジェクトや個別 IRI の解決でも、`resolveObject` への透過的フォールバックにより完全な互換性が保たれる。

## 参照

- 関連 Issue: #286, #282, #10
- 関連 ADR: [ADR-0042](0042-apex-fork-responsibility-boundary.md), [ADR-0085](0085-split-store-by-responsibility.md)
