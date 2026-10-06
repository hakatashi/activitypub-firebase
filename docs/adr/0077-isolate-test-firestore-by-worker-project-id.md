# ADR-0077: ワーカー固有の projectId によるテスト並列化とテストヘルパー共通化

- **Status:** Accepted
- **Date:** 2026-10-06

## 背景

これまでテストは単一の Firestore エミュレータと同一の `GCLOUD_PROJECT` を共有していたため、
テストファイル間のデータ競合を防ぐ目的で `fileParallelism: false` を指定して直列実行していた。
その結果、テスト全体の実行時間が約2分かかっていた。
また、エミュレータのリセット処理やローカル actor・UserInfo・トークン生成処理が
20以上のテストファイルに重複して記述され、テストコードの肥大化と保守性の低下を招いていた。

## 決定

1. **ワーカーごとの projectId 分離による並列実行**
   - Firestore エミュレータがプロジェクト ID ごとにデータを分離する特性を利用し、
     Vitest の `setupFiles` 先頭でワーカー固有の `process.env.GCLOUD_PROJECT = activitypub-firebase-dev-w${VITEST_POOL_ID ?? 0}` を設定する。
   - `firebase.ts` は `activitypub-firebase` 以外をすべて dev ドメインとして扱うため、
     ドメイン判定 (`activitypub-dev.hakatashi.com`) は維持される。
   - ワーカー間の環境変数・メモリ空間の完全分離のため Vitest の pool に `forks` を採用し、
     `fileParallelism: true` を有効化する。
2. **テストヘルパーの共通化**
   - `functions/test/helpers/` に以下を集約する。
     - `resetFirestore()`: 該当ワーカーの projectId の全ドキュメントを消去。
     - `createLocalActor()`: actor 生成、`saveObject`、`UserInfos` ドキュメント投入を一括処理。
     - `addAccessToken()`: アクセストークン投入を一括処理。
     - `mastodonRequest()`: supertest の認証ヘッダ付きラッパー。
   - `emulator/v1/projects` のエンドポイント直接呼び出しを `resetFirestore()` 1箇所のみとする。

## 結果

- `fileParallelism: false` の前提を撤廃し、テストを並列実行可能にして実行時間を大幅に短縮する。
- 各テストファイルからフィクスチャ構築・リセットのボイラープレートが排除され、テストコードの可読性が向上する。

## 参照

- 関連 Issue: [#184](https://github.com/hakatashi/activitypub-firebase/issues/184)
- 関連 ADR: [ADR-0011](0011-vitest-over-jest.md), [ADR-0076](0076-pregenerated-test-actor-keys.md)
