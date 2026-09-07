# Architecture Decision Records (ADR)

このディレクトリには、このプロジェクトの設計上の決定を1件1ファイルで記録します。

## なぜ ADR か

このプロジェクトの実装は原則としてコーディングエージェントが行い、エージェント間の引き継ぎは
リポジトリにチェックインされたドキュメントを介して行われます。決定の理由を1つの巨大なドキュメントに
書き足し続けると、すぐに読めなくなり、古い記述と新しい記述が混在して信頼できなくなります。

ADR は「1つの決定 = 1つの追記専用ファイル」にすることでこれを防ぎます。

## ルール

1. **1決定1ファイル。** ファイル名は `NNNN-kebab-case-title.md`(4桁連番)。
2. **50行以内を目安にする。** 長くなるなら決定を分割する。
3. **既存の ADR を書き換えない。** 決定が変わったら新しい ADR を書き、古い方の `Status` を
   `Superseded by ADR-NNNN` に変更する(変更するのはこの1行だけ)。
4. **`Status` は必ず記載する。** `Proposed` / `Accepted` / `Superseded by ADR-NNNN` / `Rejected`。
5. **新しい設計判断をしたら、実装を始める前に ADR を追加する。**
6. **進捗や TODO を書かない。** それは GitHub Issue に書く。

新規作成時は [`0000-template.md`](0000-template.md) をコピーしてください。

## 一覧

| # | タイトル | Status |
|---|---|---|
| [0001](0001-use-lightweight-adrs.md) | 軽量 ADR で設計判断を記録する | Accepted |
| [0002](0002-keep-activitypub-express.md) | activitypub-express を継続利用し、配送層のみ差し替える | Accepted |
| [0003](0003-delivery-via-cloud-tasks.md) | 配送は Cloud Tasks で行う | Accepted |
| [0004](0004-no-custom-ui-use-elk.md) | 自前 Web UI を作らず Mastodon 互換 API + Elk を使う | Accepted |
| [0005](0005-single-user-multi-ready-data-model.md) | 運用はシングルユーザー、データモデルはマルチユーザー対応を保つ | Accepted |
| [0006](0006-mastodon-api-id-scheme.md) | Mastodon API の ID は時系列順序を持つ独自採番にする | Accepted |
| [0007](0007-no-streaming-api.md) | ストリーミング API は実装しない | Accepted |
| [0008](0008-two-domain-split.md) | ActivityPub と Mastodon API を2つのドメインに分ける | Accepted |
| [0009](0009-rotate-actor-key-now.md) | actor の秘密鍵を Phase 0 のうちにローテーションする | Accepted |
| [0010](0010-pin-activitypub-express-4.4.1.md) | activitypub-express を 4.4.1 に固定する | Accepted |
| [0011](0011-vitest-over-jest.md) | テストランナーを Jest から Vitest に置き換える | Accepted |
| [0012](0012-delivery-results-in-firestore.md) | 配送結果を `deliveries` コレクションに記録する | Accepted |
| [0013](0013-scoped-postwork-middleware.md) | `postWork` はレスポンス前に実行し続け、パッチをリクエストスコープに閉じる | Accepted |
| [0014](0014-self-hosted-federation-test-instance.md) | 連合の検証相手として Mastodon を自前ホストする | Accepted |
| [0015](0015-fix-http-signature-keyid-fragment.md) | 配送の HTTP Signature keyId に `#main-key` を付与する | Accepted |
| [0016](0016-fix-update-activity-meta-array-corruption.md) | `updateActivityMeta` の `_meta.collection` 破損を修正する | Superseded by ADR-0017 |
| [0017](0017-meta-collection-as-array.md) | `_meta.collection` を Firestore 上でも配列として保存する | Accepted |
| [0018](0018-eslint-to-oxlint-oxfmt.md) | Lint/Format を ESLint から oxlint + oxfmt に置き換える | Accepted |
| [0019](0019-find-activity-by-collection-object-actor.md) | `findActivityByCollectionAndObjectId`/`ActorId` は片方だけを Firestore に絞り込ませる | Superseded by ADR-0020 |
| [0020](0020-denormalize-actor-object-ids.md) | `actor`/`object` の IRI を `_meta.actorIds`/`_meta.objectIds` に非正規化する | Superseded by ADR-0021 |
| [0021](0021-meta-index-as-maps.md) | `_meta` の非正規化インデックスを map 型の `_meta.index.*` に統一する | Accepted |
| [0022](0022-type-definitions-for-activitypub-express.md) | activitypub-express の型定義を自前で持ち、Store は `implements` で検証する | Accepted |
| [0023](0023-firestore-schema-as-types.md) | Firestore のコレクションは TypeScript 型で守り、読み出し時に検証しない | Accepted |
| [0024](0024-validate-external-input-with-zod.md) | 外部から来る入力は zod で検証する | Accepted |
| [0025](0025-normalize-ap-objects-instead-of-casting.md) | AP オブジェクトは正規化ヘルパーと型ガードで扱い、`as` で絞り込まない | Accepted |
| [0026](0026-ban-any-and-confine-casts-to-boundaries.md) | `any` を禁止し、型キャストを境界ファイルに閉じ込める | Accepted |
| [0027](0027-branded-firestore-key.md) | エスケープ済み Firestore キーをブランド型で区別する | Accepted |
| [0028](0028-allow-as-casts-in-test-files.md) | 型アサーションの配置ルールにテストファイルの例外を加える | Accepted |
| [0029](0029-blocklist-filter-in-application.md) | `getStream` の `blockList` フィルタはアプリケーション側で行う | Accepted |
| [0030](0030-inbox-redundant-delivery-detection.md) | inbox の重複配送検出を、apex 本体を変更せず前後の薄いミドルウェアで行う | Accepted |
| [0031](0031-update-delete-same-origin-check.md) | Update / Delete の同一オリジン検証を、apex 本体を変更せず前段ミドルウェアで行う | Accepted |
