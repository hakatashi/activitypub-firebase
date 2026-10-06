# ADR-0085: Store クラスには apex の契約だけを置き、アプリ独自のクエリはモジュール関数にする

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Issue #192。`functions/src/store.ts`(776 行)の `Store` クラスには、apex が要求する `IApexStore` の実装と、
apex が呼ばないアプリ独自のクエリ(タイムライン用の `getNotes`、`getReplies`、`getObjects`、
`markActivityPublic`)、配送記録(ADR-0012)が同居していた。アプリ独自の処理も `apex.store.xxx` の形で
呼ばれていたため、どれが apex の契約でどれがアプリの都合なのかがコードから読み取れなかった。

## 決定

1. `functions/src/store/` ディレクトリに分割する。
   - `index.ts`: `Store` クラス(`IApexStore` の実装)。apex の契約とその内部処理だけを置く。
   - `updates.ts`: `updateObject` / `updateActivity` が共有する内部処理(`_meta` の引き継ぎ、埋め込みコピーの差し替え)。
   - `objects.ts` / `notes.ts` / `activities.ts`: apex が呼ばない `objects` / `streams` のクエリと操作。
   - `deliveries.ts`: Cloud Tasks への配送タスクの発行と、配送結果の記録・取得。
   - `limits.ts`: `FIRESTORE_IN_QUERY_LIMIT` などの Firestore の制約に関する定数。
2. **apex の契約外の処理は `Store` のメソッドではなくモジュールの関数にする。** 呼び出し側は
   `apex.store.getNotes(...)` ではなく `getNotes(...)` を import して呼ぶ。apex から呼ばれる
   `deliveryEnqueue` はクラスに残し、Cloud Tasks への発行そのものは `deliveries.ts` に委ねる。
3. 新しいクエリは、apex の契約なら `store/index.ts` に、アプリ独自なら機能別のファイルに置く。
4. 呼び出し元のない `getObjectsByFieldValue` / `getObjectsCount` は移さずに削除する。

## 結果

- `apex.store.` で呼ばれるのは apex の契約のメソッドだけになる。
- アプリ独自の関数はクラスのメソッドでなくなるため、テストでは `vi.spyOn(apex.store, ...)` ではなく `vi.mock` で差し替える。
- `Store` クラスは約 500 行残る。apex の契約(20 余りのメソッド)そのものであり、これ以上の分割はクラスを委譲だけの殻にするため行わない。

## 参照

- [[0022-type-definitions-for-activitypub-express]]、[[0012-delivery-results-in-firestore]]、[[0080-social-domain-layer-and-dependency-direction]]
- 関連 Issue: [#192](https://github.com/hakatashi/activitypub-firebase/issues/192)
