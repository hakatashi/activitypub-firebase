# AGENTS.md

ActivityPub を Firebase 上でフルサーバーレスに実装するプロジェクト。
Mastodon 互換 API も提供し、Elk などのサードパーティクライアントをフロントエンドとして使う。
ユーザーは `@hakatashi@hakatashi.com` の1人のみを想定している。

**このファイルは地図とルールだけを置く。決定の理由は ADR に、進捗は GitHub Issue にある。**

## ドキュメントの地図

| 知りたいこと | 読む場所 |
|---|---|
| 今どういう構成になっているか | [`docs/architecture.md`](docs/architecture.md) |
| **なぜそう作られているか** | [`docs/adr/`](docs/adr/README.md) |
| 次に何をすべきか | [`docs/roadmap.md`](docs/roadmap.md) と各 Epic Issue |
| 壊れている箇所・技術的負債 | [`docs/known-issues.md`](docs/known-issues.md) |
| Mastodon API のどこまで実装したか | [`docs/mastodon-api-coverage.md`](docs/mastodon-api-coverage.md) |
| ビルド・テスト・デプロイの方法 | [`docs/runbooks/local-development.md`](docs/runbooks/local-development.md) |
| 連合が動くことをどう確認するか | [`docs/runbooks/federation-testing.md`](docs/runbooks/federation-testing.md) |

`third_party/` には仕様書と参考実装が submodule として置かれている
(`activitypub` = W3C 仕様、`mastodon` / `mastodon_documentation` = Mastodon 本体とドキュメント、
`minidon` / `minipub` = サーバーレス寄りの軽量実装、`rfc/` = WebFinger と acct URI の RFC)。
**仕様の確認は推測ではなくこれらを読んで行うこと。**

## 作業のルール

### ドキュメント

- **設計判断をしたら、実装を始める前に [`docs/adr/`](docs/adr/README.md) に ADR を追加する。**
  1決定1ファイル、50行以内。既存の ADR は書き換えず、新しい ADR で supersede する。
- このファイルに決定の理由を書かない。ADR にリンクする。
- **進捗・TODO をドキュメントに書かない。** GitHub Issue に書く。
- `docs/architecture.md` は現時点の姿だけを書く。履歴を残さない。
- `docs/known-issues.md` は直したら消す。履歴は git が持っている。

### GitHub Issue

- 各フェーズに Epic Issue が1本あり、子 Issue をタスクリストで束ねている。
- **子 Issue はそのフェーズに着手する時点で作る。** 全フェーズ分を先に作らない。
- ラベルは `phase:N` と `area:*` を付ける。着手前に ADR が必要なら `needs-adr` を付ける。

### プルリクエスト

- **対応する Issue がある変更は、原則として PR の本文に `Closes #N` などクローズ用の構文を入れる。**
  対応する Issue がない変更の場合は、Issue への紐付けは強制せず、そのまま PR を作成してよい。

### 検証

- **dev 環境で検証可能な変更は、PR を作成する前に積極的に dev 環境へデプロイして検証する。**
  連合が絡む変更は [`docs/runbooks/federation-testing.md`](docs/runbooks/federation-testing.md)
  の手順に従い、外部インスタンスとの疎通まで確認する(連合の不具合はローカルでは再現しない)。
- **dev 環境は検証用のデプロイ環境であり、検証のために既存データを破壊してよい。**
  本番相当のデータを維持する必要はない。
- デプロイ手順(dev 限定の手動デプロイ、バックフィルスクリプトの実行方法を含む)は
  `deploy-firebase` skill を使う。

### コード

- `main` への push で **本番と dev の両環境に自動デプロイされる。** 直接 push しない。
- 秘密鍵・アクセストークン・`Authorization` ヘッダをログに出力しない。
- Firestore へのクライアントからの直接アクセスは全面禁止されている。
  すべて Cloud Functions 経由。
- **PR を作成する前に `build` / `lint` / `format:check` / `test` を全て実行し、
  通ることを確認する。**
- **apex のフォーク (`functions/src/apex/`) から `firebase-admin` / `firebase-functions` /
  本体のモジュールを import しない。** フォークと本体の責務境界は
  [ADR-0042](docs/adr/0042-apex-fork-responsibility-boundary.md) が定める。
  境界をまたぎたくなったら、それは「その処理は本体側の責務だ」というシグナル。
  apex ライブラリ自体の単体テストは `functions/test/unit/apex/` に配置する。

## よく使うコマンド

```bash
npm --prefix functions ci             # 依存のインストール
npm --prefix functions run build      # tsc
npm --prefix functions run lint       # oxlint
npm --prefix functions run format     # oxfmt(自動整形)
npm --prefix functions run format:check # oxfmt(整形チェックのみ)
npm --prefix functions test           # Firestore エミュレータ + jest
```

## 現在の最優先事項

**Phase 1(配送)と Phase 2(受信と AP 準拠)は完了した。** 配送は Cloud Tasks 経由で動作し、
dev 環境から実在の Mastodon インスタンスへ Follow / Accept / Create が届き、
Like / Announce / Undo / Inbox Forwarding の受信も実地で確認済み
(→ [ADR-0003](docs/adr/0003-delivery-via-cloud-tasks.md)、
[`docs/runbooks/federation-testing.md`](docs/runbooks/federation-testing.md))。

次は **Phase 2.5(apex フォーク、Epic
[#103](https://github.com/hakatashi/activitypub-firebase/issues/103))** と
**Phase 3(Mastodon API、Epic
[#8](https://github.com/hakatashi/activitypub-firebase/issues/8))**。この2つは並行できる
(→ [`docs/roadmap.md`](docs/roadmap.md))。

Phase 2 で apex の不具合・実装不備を7件踏み、本体側の回避コードが apex の内部実装
(ミドルウェア配列の並び)に依存する段階まで来た。**Phase 2.5 で apex をフォークして
このリポジトリで保守し、回避コードを撤去する**(→ [ADR-0040](docs/adr/0040-fork-activitypub-express.md)、
[ADR-0041](docs/adr/0041-vendor-fork-in-tree.md)、
[ADR-0042](docs/adr/0042-apex-fork-responsibility-boundary.md))。
