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
