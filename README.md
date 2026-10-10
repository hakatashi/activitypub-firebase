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
- [docs/runbooks/client-testing.md](docs/runbooks/client-testing.md) — Elk などのクライアントでの動作確認

## 状態

**他の Mastodon インスタンスとの連合が双方向で動作し、Elk / Phanpy などのクライアントから投稿・閲覧に加えて、通知・画像付きの投稿・検索などの日常的な操作が一通り動作します。**

- **配送(Phase 1 / [#6](https://github.com/hakatashi/activitypub-firebase/issues/6))**:
  配送は Cloud Tasks に載せ替えられ([ADR-0003](docs/adr/0003-delivery-via-cloud-tasks.md))、
  dev 環境から実在の Mastodon インスタンスへのフォロー・自動 Accept・投稿・
  プロフィール更新の配送を実地で確認済みです。
- **受信と AP 仕様準拠(Phase 2 / [#7](https://github.com/hakatashi/activitypub-firebase/issues/7))**:
  inbox の重複排除、`Update`/`Delete` の同一オリジン検証、SSRF 対策、`as:Public` の表現ゆれ、
  Inbox Forwarding (7.1.2) といった MUST 要件を実装し、`Like` / `Announce` / `Undo` の
  受信までを実インスタンス相手に確認済みです
  ([docs/runbooks/federation-testing.md](docs/runbooks/federation-testing.md))。
- **apex フォーク(Phase 2.5 / [#103](https://github.com/hakatashi/activitypub-firebase/issues/103))**:
  `activitypub-express` を `functions/src/apex/` に取り込んで TypeScript 化し
  ([ADR-0040](docs/adr/0040-fork-activitypub-express.md))、本体側にあった apex の回避コードを
  すべてフォーク内へ移して撤去しました。あわせて上流由来の SSRF・署名検証の不備を塞ぎ、
  移行後も dev 環境で連合が実地で動作することを確認済みです。
- **Mastodon API(Phase 3 / [#8](https://github.com/hakatashi/activitypub-firebase/issues/8))**:
  Elk や Phanpy などのサードパーティクライアントから投稿・閲覧・タイムラインのページングが一通り動作し、
  時系列順の Mastodon ID([ADR-0006](docs/adr/0006-mastodon-api-id-scheme.md))で
  ページネーションしています([docs/runbooks/client-testing.md](docs/runbooks/client-testing.md))。

- **リファクタリング(Phase 3.5 / [#181](https://github.com/hakatashi/activitypub-firebase/issues/181))**:
  肥大化していた `mastodon/api.ts`(約2,900行)をリソースごとのルートと presenter に分割し、
  フォロー関係・お気に入り・ブーストをアクティビティログから毎回再計算するのをやめて射影に切り替えました。
  テストは並列化と鍵の事前生成で約3分11秒から約35秒に短縮し、PR の CI で型チェックも行っています。

- **通知・メディア・検索など(Phase 4 / [#9](https://github.com/hakatashi/activitypub-firebase/issues/9))**:
  通知、画像の添付(Cloud Storage)、お気に入り・ブックマークの一覧、タイムラインへのブーストの表示、
  返信数、検索(リモートのアカウント・投稿の解決とハッシュタグ)、アバター・ヘッダー・既定の公開範囲の変更、
  投稿ページの OGP を実装し、Elk / Phanpy と実在の Mastodon インスタンスの間で一通り確認済みです。

次は **Phase 5(pawoo.net からの引っ越し / [#10](https://github.com/hakatashi/activitypub-firebase/issues/10))**
に進みます([docs/roadmap.md](docs/roadmap.md))。

残っている課題や技術的負債は [docs/known-issues.md](docs/known-issues.md) を参照。

## クローン

`public/` と `third_party/` は submodule です。

```bash
git clone --recurse-submodules https://github.com/hakatashi/activitypub-firebase.git
```

`public/` は個人サイト hakatashi.com の submodule であり、本プロジェクトのコードではありません
([ADR-0008](docs/adr/0008-two-domain-split.md))。

## ライセンス

[Apache License 2.0](LICENSE)
