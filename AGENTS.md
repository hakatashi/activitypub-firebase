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

- **対応する Issue がある変更は、PR の本文に `Closes #N` などクローズ用の構文を必ず入れる。**
  対応する Issue がない小さな変更の場合は、その旨をユーザーに確認する。

### コード

- `main` への push で **本番と dev の両環境に自動デプロイされる。** 直接 push しない。
- 秘密鍵・アクセストークン・`Authorization` ヘッダをログに出力しない。
- Firestore へのクライアントからの直接アクセスは全面禁止されている。
  すべて Cloud Functions 経由。
- 連合の不具合はローカルでは再現しない。dev 環境で実際のサーバーと疎通確認する。

## よく使うコマンド

```bash
npm --prefix functions ci        # 依存のインストール
npm --prefix functions run build # tsc
npm --prefix functions run lint  # eslint
npm --prefix functions test      # Firestore エミュレータ + jest
```

## 現在の最優先事項

**Phase 1(配送)は完了した。** 配送は Cloud Tasks 経由で動作し、dev 環境から実在の
Mastodon インスタンスへ Follow / Accept / Create が届くことを実地で確認済み
(→ [ADR-0003](docs/adr/0003-delivery-via-cloud-tasks.md)、
[`docs/runbooks/federation-testing.md`](docs/runbooks/federation-testing.md))。

次は **Phase 2(受信と AP 準拠、Epic
[#7](https://github.com/hakatashi/activitypub-firebase/issues/7))** と
**Phase 3(Mastodon API、Epic
[#8](https://github.com/hakatashi/activitypub-firebase/issues/8))**。この2つは並行できる
(→ [`docs/roadmap.md`](docs/roadmap.md))。着手前に子 Issue を作ること。
