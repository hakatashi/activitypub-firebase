# ADR-0157: CI における npm キャッシュの有効化とネットワークリトライの強化

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

main への push によるデプロイワークフローで、`Lint` ジョブの `npm --prefix functions ci` が `ECONNRESET` により失敗し、本番デプロイが停止する事象が発生した (#388)。
CI で毎回全パッケージを npm レジストリからダウンロードしており、一時的なネットワーク瞬断への耐性（リトライ回数・タイムアウト）も npm デフォルト値のままだったため、外部ネットワークの揺らぎでデプロイ全体が落ちていた。

## 決定

1. **`actions/setup-node` での npm キャッシュ有効化:** `.github/workflows/main.yml` の各ジョブ (`test`, `lint`, `deploy-firebase`) で `actions/setup-node@v7` に `cache: 'npm'` および `cache-dependency-path: functions/package-lock.json` を設定する。
2. **ネットワークリトライ環境変数の設定:** ワークフローの `env` に `NPM_CONFIG_FETCH_RETRIES: 5`, `NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: 20000`, `NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: 120000` を設定し、一時的なネットワークエラー耐性を高める。
3. **失敗通知ジョブの依存関係明示:** `notify-deploy-failure` ジョブの `needs` に `test` および `lint` を追加し、ビルド・リント段階での失敗時も確実に検知・通知されるようにする。

## 理由

- npm キャッシュを活用することで外部ダウンロード通信量が劇的に削減され、ECONNRESET 等のエラー発生率を抑えるとともに CI 時間を短縮できる。
- リトライ回数を 2 から 5 に増やしタイムアウトを広げることで、一時的なネットワーク断がジョブ失敗につながるのを防ぐ。
- 通知ジョブの依存関係を明示することで、ワークフローの意図と実行条件を明確に保つ。

## 結果

ネットワーク瞬断による CI/CD 失敗のリスクが大幅に低減し、ワークフローの実行速度と安定性が向上する。

## 参照

- 関連 Issue: #388
- 関連 ADR: [ADR-0116](0116-dotenv-for-functions-params.md)
