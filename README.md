# activitypub-firebase

[WIP] ActivityPub implementation on Firebase

Firebase (Hosting + Cloud Functions + Firestore) 上に、ActivityPub と Mastodon 互換 API を
フルサーバーレスで実装する試み。シングルユーザー(`@hakatashi@hakatashi.com`)向け。

自前の Web UI は持たず、Mastodon 互換 API 経由で Elk などのサードパーティクライアントを使う。

## ドキュメント

- [AGENTS.md](AGENTS.md) — 開発の起点。ドキュメントの地図と作業ルール
- [docs/architecture.md](docs/architecture.md) — アーキテクチャ
- [docs/adr/](docs/adr/README.md) — 設計判断の記録 (ADR)
- [docs/roadmap.md](docs/roadmap.md) — フェーズと進め方
- [docs/known-issues.md](docs/known-issues.md) — 既知の問題
- [docs/mastodon-api-coverage.md](docs/mastodon-api-coverage.md) — Mastodon API の実装状況
- [docs/runbooks/local-development.md](docs/runbooks/local-development.md) — ビルド・テスト・デプロイ
- [docs/runbooks/federation-testing.md](docs/runbooks/federation-testing.md) — 連合の動作確認

## 状態

**連合の基本的な往復が動作します。** 配送は Cloud Tasks に載せ替えられ
([ADR-0003](docs/adr/0003-delivery-via-cloud-tasks.md))、dev 環境から実在の Mastodon
インスタンスへのフォロー・自動 Accept・投稿・プロフィール更新の配送を実地で確認済みです
(Phase 1 / [Issue #6](https://github.com/hakatashi/activitypub-firebase/issues/6))。

ただし受信側の仕様準拠(Phase 2)と Mastodon API(Phase 3)は未完成で、
日常利用には耐えません。残っている不具合は
[docs/known-issues.md](docs/known-issues.md) を参照。

## クローン

`public/` と `third_party/` は submodule です。

```bash
git clone --recurse-submodules https://github.com/hakatashi/activitypub-firebase.git
```

`public/` は個人サイト hakatashi.com の submodule であり、本プロジェクトのコードではありません
([ADR-0008](docs/adr/0008-two-domain-split.md))。

## ライセンス

[Apache License 2.0](LICENSE)
