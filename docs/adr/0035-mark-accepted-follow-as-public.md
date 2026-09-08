# ADR-0035: 承認した Follow に `_meta.isPublic` を付与し followers を匿名公開する

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

Issue #55 の実地検証で、`GET /activitypub/u/hakatashi/followers?page=true` に匿名でアクセスすると
`orderedItems` が常に空になることを `mastodon-test.hakatashi.com` との実連合で確認した
(`totalItems` は正しい値を返す)。

apex の `getCollection` は `includePrivate` が偽(匿名アクセス)のとき
`stream.filter(act => this.isPublic(act))` でページ内容を絞り込む。
`isPublic()` は `_meta.isPublic` か、アクティビティの `to`/`cc`/`audience` に
`as:Public` が含まれるかのいずれかを見る。

しかし Follow アクティビティは(Mastodon を含む一般的な実装で)`to`/`cc` を一切持たない
ため、`_meta.isPublic` を明示的に立てない限り必ず false になり、承認済みの Follow が
すべてフィルタで落ちる。

[ADR-0034](0034-normalize-public-address-on-inbox.md) は「届いた `to`/`cc` の `Public` 表記
揺れの正規化」であり、`to`/`cc` フィールド自体が存在しないこのケースには効果がない。
Issue #7 の完了条件はこの修正を ADR-0034 で完了したものとして扱っていたが、
実地検証の結果、根本原因は未修正だったことが分かった。

## 決定

**Follow を自動承認する際 (`apex.acceptFollow` の直後) に、対象の Follow アクティビティへ
`_meta.isPublic: true` を書き込む。**

- `Store` (`functions/src/store.ts`) に `markActivityPublic(activity)` を追加し、
  `_meta.isPublic` を Firestore に直接書き込む。
- `functions/src/activitypub.ts` の `onApexInbox` の Follow 分岐で `acceptFollow` の後に呼ぶ。

## 理由

- followers コレクション(誰にフォローされているか)は Mastodon を含む多くの実装で
  匿名にも公開される情報であり、Follow アクティビティ自体の宛先とは無関係に
  「フォロワーとして確定した」時点で公開扱いにするのが自然。
- `isPublic()` は `_meta.isPublic` を明示的なオーバーライドとして参照する設計になっており
  ([ADR-0034](0034-normalize-public-address-on-inbox.md) 実装時に確認)、
  これを使うのが apex 本体に手を入れない最小の対応になる (→ [ADR-0002](0002-keep-activitypub-express.md))。
- 実装は既存の `Store.updateActivityMeta`(`_meta.collection` 専用の配列 union 実装)とは
  性質が異なる(真偽値フラグ)ため、専用メソッドとして分離する。

## 結果

- `functions/src/store.ts` に `markActivityPublic` を追加し、`ApexStore` 型定義
  (`functions/types/activitypub-express.d.ts`)にも追加する。
- `functions/src/meta.ts` の `ObjectMeta` に `isPublic?: boolean` を追加する。
- 匿名の `/followers?page=true` が承認済みフォロワーを返すことをテストで固定する。

## 参照

- [[0002-keep-activitypub-express]]
- [[0034-normalize-public-address-on-inbox]]
- 関連 Issue: [#55](https://github.com/hakatashi/activitypub-firebase/issues/55)
