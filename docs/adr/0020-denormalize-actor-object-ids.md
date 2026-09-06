# ADR-0020: `actor`/`object` の IRI を `_meta.actorIds`/`_meta.objectIds` に非正規化する

- **Status:** Superseded by ADR-0021
- **Date:** 2026-09-06

## 背景

[ADR-0019](0019-find-activity-by-collection-object-actor.md) は
`findActivityByCollectionAndObjectId`/`findActivityByCollectionAndActorId` を
生の `object`/`actor` フィールドに対する `array-contains` で実装した。これは
「Mastodon は Follow/Block の `actor`/`object` を常に IRI 文字列で送る」という観測
(`third_party/mastodon/app/serializers/activitypub/follow_serializer.rb` 等)に基づいていたが、
2点で不十分だった。

1. **仕様上の裏付けがない。** AS2 の `actor`/`object` は IRI 文字列・Link・埋め込みオブジェクトの
   いずれにもなりうる。「相手は事実上 Mastodon」という前提はこのプロジェクトの他のドキュメント
   (ADR-0005 含む)のどこにも書かれておらず、実装依存の仮定に過ぎない。
2. **実際に埋め込みオブジェクトが観測された。** dev 環境の `streams` に実在する
   `https://mstdn.jp/users/hakatashi#follows/7885872/undo` は
   `object: [{ id: '...', type: 'Follow', actor: [...], object: [...] }]` という埋め込み
   オブジェクトを持つ(Mastodon 自身の `UndoFollowSerializer` が `has_one :object, serializer:
   FollowSerializer` で Follow を丸ごと埋め込むため)。生の `object` フィールドに対する
   `array-contains` はスカラー一致のみなので、このような埋め込みには一致しない。

`functions/src/denormalizations.ts` の `onStreamCreated` にも同種の前提
(`stream.actor[0]` や `object` を無条件に文字列として `escapeFirestoreKey` に渡す)があり、
埋め込みオブジェクトが来ると `TypeError` で落ちる経路だった。

## 決定

**`actor`/`object` から常にスカラーの IRI 文字列を取り出す `toIdArray`(`functions/src/utils.ts`)
を用意し、`onStreamWritten`(`functions/src/denormalizations.ts`)で `_meta.actorIds`/
`_meta.objectIds` として非正規化する。** `activitypub-express/pub/utils.js` の
`actorIdFromActivity`/`objectIdFromActivity` と同じ判定(文字列 → そのまま、
`type === 'Link'` → `href[0]`、それ以外 → `.id`)を配列全体に適用する。

- `findActivityByCollectionAndObjectId`/`findActivityByCollectionAndActorId`
  (`store.ts`)は生の `object`/`actor` ではなく `_meta.objectIds`/`_meta.actorIds` を
  `array-contains` で引く。`_meta.collection` との組み合わせは引き続き Firestore の
  「`array-contains` は1クエリにつき1つまで」という制約(ADR-0019 で確認済み)を受けるため、
  対象アクターの IRI 側だけを Firestore に絞り込ませ、`_meta.collection` はアプリケーション側で
  判定する設計は維持する。
- `removeActivity`(`store.ts`)と `getFollowers`(`mastodon/api.ts`)も同じ理由で
  `_meta.actorIds`/`_meta.objectIds` を使うよう変更する。
- `onStreamCreated` の `statuses_count`/`followers_count` 更新も `toIdArray` を経由させ、
  埋め込みオブジェクトが来ても例外にならないようにする。
- `functions/bin/denormalizations.ts`(バックフィルスクリプト)にも同じ非正規化ロジックを追加する。
- `firestore.indexes.json` の `streams` 用インデックスを `object`/`actor` から
  `_meta.objectIds`/`_meta.actorIds` に差し替える。

## 理由

- `_meta.objectType`/`_meta.objectTypes`(ADR より前から存在)が同じ「トリガーで非正規化して
  クエリ可能にする」パターンを既に採用しており、設計として一貫する。
- `toIdArray` の判定基準を activitypub-express 自身の実装(`actorIdFromActivity`/
  `objectIdFromActivity`)に合わせることで、独自解釈ではなく依存ライブラリと同じ IRI 解決規則に
  従うことが保証できる。

## 結果

- `_meta.actorIds`/`_meta.objectIds` は `onStreamWritten` トリガーが書き込むため、
  ドキュメント作成直後の同一リクエスト内でこれらのフィールドを前提にした参照は避ける必要がある
  (既存の `_meta.objectType` も同じ制約を持つ)。このプロジェクトで
  `findActivityByCollectionAndObjectId`/`ActorId` が実際に呼ばれるのは outbox 経由の
  Undo/Reject 検証時のみで、検索対象の Follow/Block は別リクエストで既に確定済みのため、
  実運用上この遅延が問題になることはない。
- 既存の `streams` ドキュメントは `functions/bin/denormalizations.ts` のバックフィル実行後に
  `_meta.actorIds`/`_meta.objectIds` を持つ。

## 参照

- Supersedes [[0019-find-activity-by-collection-object-actor]]
- 関連 Issue: [#49](https://github.com/hakatashi/activitypub-firebase/issues/49)
- `functions/src/utils.ts`, `functions/src/denormalizations.ts`, `functions/src/store.ts`,
  `functions/src/mastodon/api.ts`, `functions/bin/denormalizations.ts`
