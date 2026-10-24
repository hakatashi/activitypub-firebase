# ADR-0164: PR CI で Elk / Phanpy のクライアント E2E テストを実行する

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

Dependabot による npm 依存更新を安全に自動マージするためには、Functions のデプロイや最小限のスモークテスト（ADR-0163）だけでなく、Mastodon クライアント（Elk / Phanpy）から見た UI 動作や API 互換性の回帰を PR 段階で検出する必要がある。従来は HakataMatrix 上で手動実行していたが、CI 内での自動検証が求められていた。

## 決定

1. **`dev-smoke-test.yml` に `client_e2e` ジョブを追加する。** dev への Functions デプロイ・スモークテスト完了後に直列で実行し、同一 PR の head コミットに対して検証する。
2. **Elk および Phanpy を CI ランナー上で起動する。** それぞれ `127.0.0.1:5314`、`127.0.0.1:5315` で起動し、`tools/client-e2e/run.mjs` による閲覧テストを実行する。
3. **クライアントのビルド成果物を submodule SHA でキャッシュする。** `actions/cache` を用い、`third_party/elk/.output` と `third_party/phanpy/dist` を submodule のコミット SHA をキーとしてキャッシュし、CI 実行時間を短縮する。
4. **`MASTODON_DEV_TOKEN` を CI 実行時に動的発行・破棄する。** トークン未設定時は `functions/bin/devToken.ts` が `GCP_SA_KEY` を用いて dev Firestore 上に一時アクセストークンを作成し、テスト終了時に破棄する。
5. **`run.mjs` に既知の安全な出力の許可リストを導入する。** Web Push 404、リモート画像 CORS 失敗、画面遷移時の AbortError、blob URL 破棄などの無害な出力を許可リストで除外・記録し、誤検知によるテスト失敗を防ぐ。
6. **安定稼働を確認するまで branch ruleset の必須チェックには含めない。**

## 理由

- PR ごとにサードパーティクライアントからの閲覧テストを自動実行することで、API のレスポンス形式破壊や重大なクライアント動作不具合を早期検知できる。
- 静的トークンのシークレット管理を避け、CI 実行時のみ有効な一時トークンを自動発行・破棄することで、dev データのリセット耐性とセキュリティを両立できる。

## 結果

- PR 作成時および Dependabot による更新時に、dev デプロイ後に Elk / Phanpy を通じた E2E テストが自動実行され、スクリーンショットとレポートが artifact として保存される。

## 参照

- 関連 Issue: [#396](https://github.com/hakatashi/activitypub-firebase/issues/396)
- 関連 ADR: [[0066-self-hosted-clients-driven-by-playwright]], [[0163-deploy-dev-and-smoke-test-on-pr]]
- 関連ドキュメント: `docs/runbooks/client-testing.md`
