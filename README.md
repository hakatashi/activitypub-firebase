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

**他の Mastodon インスタンスとの連合が双方向で動作します。**

- **配送(Phase 1 / [#6](https://github.com/hakatashi/activitypub-firebase/issues/6))**:
  配送は Cloud Tasks に載せ替えられ([ADR-0003](docs/adr/0003-delivery-via-cloud-tasks.md))、
  dev 環境から実在の Mastodon インスタンスへのフォロー・自動 Accept・投稿・
  プロフィール更新の配送を実地で確認済みです。
- **受信と AP 仕様準拠(Phase 2 / [#7](https://github.com/hakatashi/activitypub-firebase/issues/7))**:
  inbox の重複排除、`Update`/`Delete` の同一オリジン検証、SSRF 対策、`as:Public` の表現ゆれ、
  Inbox Forwarding (7.1.2) といった MUST 要件を実装し、`Like` / `Announce` / `Undo` の
  受信までを実インスタンス相手に確認済みです
  ([docs/runbooks/federation-testing.md](docs/runbooks/federation-testing.md))。

現在は **Phase 2.5(`activitypub-express` のフォークを取り込み、回避コードを解消する /
[#103](https://github.com/hakatashi/activitypub-firebase/issues/103)、
[ADR-0040](docs/adr/0040-fork-activitypub-express.md))** と
**Phase 3(Mastodon API / [#8](https://github.com/hakatashi/activitypub-firebase/issues/8))**
を並行して進めています。

**Mastodon API はまだ日常利用に耐えません**(投稿 API が未実装、タイムラインに
ページネーションと公開範囲判定がないなど)。残っている不具合は
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
