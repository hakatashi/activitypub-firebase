# ADR-0132: 本番・dev へのデプロイを直列に実行する

- **Status:** Accepted
- **Date:** 2026-10-21

## 背景

`main.yml` のデプロイ系ジョブは、本番と dev を matrix で並列に実行していた。
また `main` への push が続くと、別の run のデプロイ同士が重なり得た。
Functions / Firestore のデプロイが並行すると、古いコミットのデプロイが後から完了して
新しいコミットを上書きしたり、同一プロジェクトへの同時デプロイが競合して失敗したりする。

## 決定

- ワークフローに `concurrency` を設定し、`main` への push の run は group `deploy-main` で
  1 つずつ実行する。`cancel-in-progress` は `false`(実行中のデプロイを中断しない)。
- 待機中の run が複数あるときは最新のものだけが残り、古い待機中の run はキャンセルされる。
  デプロイは最新のコミットに到達すればよいので許容する。
- PR の run はデプロイしないため、`pr-<ref>` の group に分け、新しい push で古い run をキャンセルする。
- `deploy-firebase` / `deploy-hosting` の matrix に `max-parallel: 1` を指定し、
  本番と dev を並列にデプロイしない。

## 結果

- デプロイは常に 1 プロジェクト・1 ジョブずつ進み、順序が push の順序に従う。
- 全体の所要時間は延びる。
