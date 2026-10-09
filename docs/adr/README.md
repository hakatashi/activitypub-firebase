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
| [0002](0002-keep-activitypub-express.md) | activitypub-express を継続利用し、配送層のみ差し替える | Superseded by ADR-0040 |
| [0003](0003-delivery-via-cloud-tasks.md) | 配送は Cloud Tasks で行う | Accepted |
| [0004](0004-no-custom-ui-use-elk.md) | 自前 Web UI を作らず Mastodon 互換 API + Elk を使う | Accepted |
| [0005](0005-single-user-multi-ready-data-model.md) | 運用はシングルユーザー、データモデルはマルチユーザー対応を保つ | Accepted |
| [0006](0006-mastodon-api-id-scheme.md) | Mastodon API の ID は時系列順序を持つ独自採番にする | Accepted |
| [0007](0007-no-streaming-api.md) | ストリーミング API は実装しない | Accepted |
| [0008](0008-two-domain-split.md) | ActivityPub と Mastodon API を2つのドメインに分ける | Accepted |
| [0009](0009-rotate-actor-key-now.md) | actor の秘密鍵を Phase 0 のうちにローテーションする | Accepted |
| [0010](0010-pin-activitypub-express-4.4.1.md) | activitypub-express を 4.4.1 に固定する | Superseded by ADR-0040 |
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
| [0022](0022-type-definitions-for-activitypub-express.md) | activitypub-express の型定義を自前で持ち、Store は `implements` で検証する | Superseded by ADR-0040 |
| [0023](0023-firestore-schema-as-types.md) | Firestore のコレクションは TypeScript 型で守り、読み出し時に検証しない | Accepted |
| [0024](0024-validate-external-input-with-zod.md) | 外部から来る入力は zod で検証する | Accepted |
| [0025](0025-normalize-ap-objects-instead-of-casting.md) | AP オブジェクトは正規化ヘルパーと型ガードで扱い、`as` で絞り込まない | Accepted |
| [0026](0026-ban-any-and-confine-casts-to-boundaries.md) | `any` を禁止し、型キャストを境界ファイルに閉じ込める | Accepted |
| [0027](0027-branded-firestore-key.md) | エスケープ済み Firestore キーをブランド型で区別する | Accepted |
| [0028](0028-allow-as-casts-in-test-files.md) | 型アサーションの配置ルールにテストファイルの例外を加える | Accepted |
| [0029](0029-blocklist-filter-in-application.md) | `getStream` の `blockList` フィルタはアプリケーション側で行う | Accepted |
| [0030](0030-inbox-redundant-delivery-detection.md) | inbox の重複配送検出を、apex 本体を変更せず前後の薄いミドルウェアで行う | Superseded by ADR-0049 |
| [0031](0031-update-delete-same-origin-check.md) | Update / Delete の同一オリジン検証を、apex 本体を変更せず前段ミドルウェアで行う | Superseded by ADR-0046 |
| [0032](0032-ssrf-safe-remote-object-fetch.md) | リモートオブジェクト取得 (`requestObject`) を自前の SSRF セーフな実装に差し替える | Superseded by ADR-0050 |
| [0033](0033-denormalize-undo-object.md) | inbox で受信した Undo の object を保存前に解決済みオブジェクトで埋め込む | Superseded by ADR-0048 |
| [0034](0034-normalize-public-address-on-inbox.md) | inbox で受信したアクティビティの as:Public 宛先表現を正規化する | Superseded by ADR-0045 |
| [0035](0035-mark-accepted-follow-as-public.md) | 承認した Follow に `_meta.isPublic` を付与し followers を匿名公開する | Accepted |
| [0036](0036-reject-unsupported-http-signature-format-early.md) | draft-cavage 以外の署名形式を事前に 403 で弾く | Superseded by ADR-0044 |
| [0037](0037-denormalize-like-announce-counts.md) | Like/Announce のカウントを `_meta` の非正規化カウンタとして持つ | Accepted |
| [0038](0038-resolve-like-announce-object-as-plain-object.md) | Like/Announce の object を Note などの通常オブジェクトとしても解決する | Superseded by ADR-0047 |
| [0039](0039-scope-statuses-count-to-create.md) | `statuses_count` の非正規化を `Create` ストリームだけに限定する | Accepted |
| [0040](0040-fork-activitypub-express.md) | activitypub-express をフォークし、このリポジトリで保守する | Accepted |
| [0041](0041-vendor-fork-in-tree.md) | apex のフォークは in-tree に置き、モノレポ化しない | Accepted |
| [0042](0042-apex-fork-responsibility-boundary.md) | apex フォークと本体コードの責務境界 | Accepted |
| [0043](0043-smoke-test-dev-with-activitypub-testing.md) | activitypub-testing による dev 環境デプロイ後スモークテストの導入 | Accepted |
| [0044](0044-self-implemented-http-signature-in-apex-fork.md) | HTTP 署名検証・生成を apex フォーク内に自前実装しエラーを分類する | Accepted |
| [0045](0045-normalize-public-address-in-apex-jsonld.md) | apex フォークの JSON-LD 処理層で as:Public 宛先表現を正規化する | Accepted |
| [0046](0046-validate-owner-same-origin-in-apex.md) | Update / Delete の同一オリジン検証を apex フォークの validateOwner に組み込む | Accepted |
| [0047](0047-resolve-like-announce-object-in-apex.md) | Like / Announce の object 解決を apex フォークの validators で通常オブジェクトに対応させる | Accepted |
| [0048](0048-denormalize-undo-object-in-apex.md) | Undo の object を apex フォークの activity.save で denormalizeObject 対象に含める | Accepted |
| [0049](0049-save-activity-return-contract-and-inbox-dedup.md) | saveActivity の戻り値契約を明示化し、重複配送検出を Store と apex 内で完結させる | Accepted |
| [0050](0050-ssrf-safe-request-object-in-apex.md) | SSRF セーフな `requestObject` を apex フォークに取り込む | Accepted |
| [0051](0051-typescript-apex-fork.md) | apex フォークを TypeScript / ESM 化し、型を実装から導出する | Accepted |
| [0052](0052-connect-apex-specs-to-firestore-store.md) | apex 同梱 spec を Firestore Store の適合テストとして繋ぎ直す | Accepted |
| [0053](0053-prevent-object-corruption-and-counter-underflow.md) | 受信処理における既存オブジェクトの上書き防止と非正規化カウンタの保護 | Accepted |
| [0054](0054-ssrf-safe-jsonld-context-loader.md) | `jsonldContextLoader` での SSRF 防御と 4xx エラー応答 | Accepted |
| [0055](0055-resolve-references-limits-and-cycle-detection.md) | `resolveReferences` での循環参照検出・探索数制限・タグ再帰抑止 | Accepted |
| [0056](0056-verify-digest-and-date-window-in-http-signature.md) | HTTP 署名検証における Digest 検証と Date 有効期限チェックの追加 | Accepted |
| [0057](0057-support-rfc-9421-via-standard-library.md) | RFC 9421 (HTTP Message Signatures) に標準ライブラリ http-message-sig で対応する | Accepted |
| [0058](0058-mastodon-id-snowflake-layout.md) | Mastodon ID の具体的な採番方式と IRI との相互マッピング | Accepted |
| [0059](0059-never-refetch-local-objects.md) | ローカルオブジェクトを HTTP で取り直さず、fullReplace でも _meta を引き継ぐ | Accepted |
| [0060](0060-derive-status-attributes-from-note.md) | Status エンティティの属性を Note の実データから導出する | Accepted |
| [0061](0061-timeline-actor-filter-and-visibility.md) | タイムラインは actor で絞り、可視性を1箇所で判定する | Accepted |
| [0062](0062-cursor-pagination-by-mastodon-id.md) | ページネーションは Mastodon ID のカーソルで行い、Firestore は published で範囲を絞る | Accepted |
| [0063](0063-post-status-and-idempotency-key.md) | POST /api/v1/statuses の Note 組み立てと Idempotency-Key の保持 | Partially superseded by ADR-0092 |
| [0064](0064-get-delete-statuses-and-context.md) | GET / DELETE /api/v1/statuses/:id と /context のスレッド走査・削除仕様 | Accepted |
| [0065](0065-account-endpoints-and-follow-unfollow.md) | アカウント系エンドポイントとフォロー・アンフォローの ActivityPub 連携 | Accepted |
| [0066](0066-self-hosted-clients-driven-by-playwright.md) | クライアント互換性の検証に Elk / Phanpy を自前ホストし Playwright で操作する | Accepted |
| [0067](0067-stubs-markers-and-instance-info.md) | クライアント起動用スタブ・既読マーカー・インスタンス情報の整備 | Accepted |
| [0068](0068-app-registration-oauth-revocation-and-pkce.md) | アプリ登録の配列対応・トランザクション採番・OAuth トークン失効と PKCE | Accepted |
| [0069](0069-mastodon-account-id-and-status-mentions.md) | アカウント ID の採番と Status mentions の実 ID 解決 | Accepted |
| [0070](0070-status-viewer-attributes-and-storage.md) | Status の認証ユーザー依存属性の導出と保存形式 | Partially superseded by ADR-0084 |
| [0071](0071-post-content-formatting-and-mentions.md) | 投稿本文の解析・自動変換とメンション解決 | Accepted |
| [0072](0072-match-array-attributed-to-in-note-queries.md) | Note の投稿者検索は配列形式の `attributedTo` にも一致させる | Superseded by ADR-0086 |
| [0073](0073-lookup-cached-remote-accounts.md) | `accounts/lookup` は手元にキャッシュ済みのリモート actor を返す | Accepted |
| [0074](0074-mastodon-api-authentication-error-handling.md) | Mastodon API の認証エラーハンドリングと統一的なエラー応答 | Accepted |
| [0075](0075-recompute-follow-counts.md) | フォロー数・フォロワー数は差分更新ではなく再計算で持つ | Superseded by ADR-0082 |
| [0076](0076-pregenerated-test-actor-keys.md) | テスト時の Actor 鍵ペアに事前生成した固定鍵を使う | Accepted |
| [0077](0077-isolate-test-firestore-by-worker-project-id.md) | ワーカー固有の projectId によるテスト並列化とテストヘルパー共通化 | Accepted |
| [0078](0078-consolidate-local-actor-configuration.md) | 単一ユーザー前提のローカルアクター設定の集約 | Accepted |
| [0079](0079-typecheck-tests-and-bin.md) | テストと bin/ を型チェックの対象にし、PR の CI で build と typecheck を実行する | Accepted |
| [0080](0080-social-domain-layer-and-dependency-direction.md) | ソーシャルドメイン層の切り出しと依存方向の単方向化 | Accepted |
| [0081](0081-mastodon-http-errors-validation-and-loaders.md) | Mastodon API の HttpError、検証ミドルウェア、リソースローダーの導入 | Accepted |
| [0082](0082-project-follow-relations-in-store.md) | フォロー関係を userInfos のサブコレクションに射影し、Store で差分更新する | Accepted |
| [0083](0083-read-follow-relations-from-projection.md) | フォロー関係の読み取りを射影に切り替え、全件の再計算を撤去する | Accepted |
| [0084](0084-project-favourites-and-reblogs.md) | お気に入り・ブーストの閲覧者状態を userInfos のサブコレクションに射影する | Accepted |
| [0085](0085-split-store-by-responsibility.md) | Store クラスには apex の契約だけを置き、アプリ独自のクエリはモジュール関数にする | Accepted |
| [0086](0086-normalize-object-query-fields-into-meta.md) | objects の検索用フィールドを `_meta` に正規化し、OR クエリをなくす | Accepted |
| [0087](0087-upgrade-to-express-5.md) | Express 5 に上げ、async ハンドラの独自ラッパーを撤去する | Accepted |
| [0088](0088-project-notifications-in-store.md) | 受信したアクティビティを通知として userInfos に射影し、Store で差分更新する | Accepted |
| [0089](0089-notifications-api.md) | 通知 API の実装と組み立て・ページネーション・未読管理の仕様 | Accepted |
| [0090](0090-derive-media-attachments-from-note.md) | Note の attachment から MediaAttachment を導出する | Accepted |
| [0091](0091-media-upload-and-storage.md) | メディアのアップロードと Cloud Storage 保存 | Accepted |
| [0092](0092-post-status-with-media-and-attachment-lifecycle.md) | media_ids によるメディア添付投稿とライフサイクル | Accepted |
| [0093](0093-split-media-upload-function.md) | メディアアップロード API の独立 Function 分離とリソース設計 | Accepted |
| [0094](0094-avatar-header-update-and-credentials.md) | アバター・ヘッダー画像の変更とプロフィール管理 | Accepted |
| [0095](0095-represent-boost-as-status-entity.md) | ブースト(Announce)を Status エンティティとして表現する | Accepted |
| [0096](0096-boosts-in-timelines-and-account-statuses.md) | ホームタイムラインとアカウント投稿一覧にブースト(Announce)を表示する | Accepted |

| [0097](0097-search-and-resolve-remote-resources.md) | `search` でアカウントを検索し、`resolve=true` でリモートのアカウント・投稿を解決する | Accepted |
| [0098](0098-sign-outgoing-get-with-local-actor.md) | 外部への GET をローカル actor の鍵で署名する | Accepted |
| [0099](0099-graceful-fallback-for-unresolved-actors-in-timelines.md) | タイムライン構築時に未解決アクターを安全にフォールバックする | Accepted |
| [0100](0100-cursor-for-favourites-and-bookmarks.md) | お気に入り・ブックマーク一覧のカーソルを `cursorId` として持つ | Accepted |
| [0101](0101-favourited-by-and-reblogged-by.md) | `favourited_by` / `reblogged_by` は streams を全件読んでアプリ側でページングする | Accepted |
| [0102](0102-replies-count-as-denormalized-counter.md) | 返信数を返信先 Note の `_meta.repliesCount` に Store で非正規化する | Accepted |
| [0103](0103-hashtag-timeline-and-search.md) | ハッシュタグを `_meta.hashtags` に正規化し、タグのタイムラインと検索を引く | Accepted |
