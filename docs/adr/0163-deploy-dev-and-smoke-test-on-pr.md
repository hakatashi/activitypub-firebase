# ADR-0163: PR 時の dev への Functions デプロイとスモークテスト自動化

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

Dependabot による npm 依存更新を自動マージして本番反映する方針を進めるにあたり、従来の PR CI では Functions のデプロイ・実行環境での動作（sharp などのネイティブ依存解決、関数解析、メモリ不足、ランタイム起動）を検証できていなかった。またデプロイ後の既存スモークテストは actor の GET 応答のみで、inbox 受信や署名検証、Mastodon API は検証していなかった。

## 決定

1. **PR 時に dev 環境へ Functions をデプロイするワークフローを追加する。** 同一リポジトリのブランチおよび Dependabot による PR を対象とし、`activitypub-firebase-dev` へ Functions・Firestore・Storage をデプロイする。
2. **secrets と実行権限を dev プロジェクト内に閉じる。** Dependabot の PR に secrets を渡すため `pull_request_target` と `pull_request` を使い分け、実行対象を同一リポジトリの PR の head コミットに限定する。dev のサービスアカウントキーの権限は dev プロジェクト内に閉鎖されていることを確認済みとする。
3. **dev 環境へのデプロイを直列化する。** dev 環境の競合を防ぐため `concurrency` でグループ化し、`cancel-in-progress: false` で直列実行する。
4. **デプロイ後にスモークテストを実行し、ruleset の必須チェックとする。**
   - actor / コレクションの適合性チェック (`activitypub-testing`)
   - HTTP 署名付き inbox への疎通確認
   - Mastodon API の最小確認 (`verify_credentials`, `timelines/home`)
   - テスト完了を main ブランチ ruleset の必須チェック (`required_status_checks`) に設定する。

## 理由

- PR の段階で Functions の実機デプロイと基礎的な主要エンドポイント（ActivityPub / Mastodon API）の疎通を自動検証することで、Dependabot PR の安全な自動マージを実現し、本番デプロイ時の障害を未然に防ぐ。

## 結果

- PR 作成時および Dependabot による更新時に dev 環境へのデプロイとスモークテストが直列に実行され、パスしない限り main へのマージができなくなる。

## 参照

- 関連 Issue: [#395](https://github.com/hakatashi/activitypub-firebase/issues/395)
- 関連 ADR: [[0043-smoke-test-dev-with-activitypub-testing]], [[0154-exclude-dev-environment-from-main-deploy]]
- 関連ワークフロー: `.github/workflows/dev-smoke-test.yml`
