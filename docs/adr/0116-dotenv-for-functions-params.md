# ADR-0116: Functions パラメータの dotenv 管理と CI デプロイ

- **Status:** Accepted
- **Date:** 2026-10-11
- **Supersedes:** [ADR-0113](0113-temporary-min-instances-during-migration.md) の切り替え方法 (第3項)

## 背景

ADR-0113 で導入した `params.defineInt('ACTIVITYPUB_MIN_INSTANCES', { default: 0 })` は、非対話モードの `firebase deploy` において `default` 値があっても dotenv (`functions/.env*`) に定義がないとエラーになる。`.env*` は全般的に gitignore されていたため、CI (GitHub Actions) 上でパラメータが未定義となり、#276 以降のデプロイが失敗していた (#280)。また Functions デプロイの失敗が Hosting のデプロイ成功に隠れて検知しにくかった。

## 決定

1. **`functions/.env` の追跡:** `.gitignore` に `!functions/.env` を追加し、全プロジェクト共通の非機密パラメータ定義として `ACTIVITYPUB_MIN_INSTANCES=0` を git 管理する。プロジェクト固有の `.env.<project>` は引き続き除外する。
2. **切り替え方法:** アカウント移行時の `minInstances: 1` への切り替えは、`functions/.env` の `ACTIVITYPUB_MIN_INSTANCES=1` への変更をコミットして main へマージすることで行う。移行完了後は `0` に戻してマージする。
3. **CI デプロイ順序と通知:** Hosting デプロイを Functions デプロイの成功に依存させ (`needs: [deploy-firebase]`)、デプロイワークフロー失敗時に GitHub Issue を作成・更新して確実に検知できるようにする。
4. **パラメータ検証テスト:** 単体テスト (`test/unit/params.spec.ts`) で宣言された全パラメータが非対話モードで解決可能であることを検証し、PR の段階で検知する。

## 理由

- `functions/.env` をリポジトリ管理することで、CI およびローカルデプロイの再現性を保ち、環境設定の差分を PR とレビューの履歴に残せる。
- Hosting デプロイを Functions の後に配置することで、バックエンドデプロイ失敗時にフロントエンドのみ更新されて不整合や誤認が生じるのを防ぐ。

## 結果

CI の Functions デプロイが正常化し、今後のパラメータ追加時も PR CI で検証漏れを防ぎ、失敗時は Issue 通知で早期検知できる。

## 参照

- 関連 Issue: #280, #262, #273
- 関連 ADR: [ADR-0113](0113-temporary-min-instances-during-migration.md)
