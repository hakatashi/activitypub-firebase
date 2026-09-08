# ADR-0043: activitypub-testing による dev 環境デプロイ後スモークテストの導入

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

Issue #101 で外部の ActivityPub 検証ツールの採用を検討した。連合の動作確認は `docs/runbooks/federation-testing.md` の実機テストで行うが、Actor オブジェクトの公開や各コレクション（inbox, outbox, followers, following, liked）の AS2 応答構造などの基礎的なデグレードを自動で早期検知するスモークテストが必要である。

## 決定

dev 環境へのデプロイ後に `activitypub-testing test actor` を実行するスモークテストを導入する。デプロイの成否とテストの成否を切り分けるため、GitHub Actions の独立した job として定義する。

## 理由

- `activitypub-testing` は Node.js エコシステムで `npx` によりセットアップ不要で実行でき、稼働中の dev actor に対するブラックボックス検証が可能。
- Actor / 各種コレクションの GET 応答と `OrderedCollection` 準拠性を一括で自動検証できる。
- デプロイの成否（Functions / Hosting の更新自体が通ったか）と、その後の動作確認の成否を Actions の job 単位で明確に分けることで、障害原因の切り分けを容易にする。
- WebFinger や HTTP Signatures、S2S 連合フローなどのツール範囲外の機能は、従来通り runbook の実地テストで確認する。

## 結果

- dev 環境への push デプロイ後に Actor およびコレクションの GET 応答適合性が自動検証される。
- C2S outbox POST のテストは未認可のため 403 (`cantTell`) となるが、`failed` ではないためジョブは正常終了する。
- ローカルや手動での確認時にも `npx activitypub-testing test actor <actor-url>` で容易にスモークテストを実行できる。

## 参照

- 関連 Issue: [#101](https://github.com/hakatashi/activitypub-firebase/issues/101)
- 関連 ADR: [ADR-0014](0014-self-hosted-federation-test-instance.md)
- 関連ドキュメント: [`docs/runbooks/federation-testing.md`](../runbooks/federation-testing.md)
- 関連ワークフロー: [`.github/workflows/main.yml`](../../.github/workflows/main.yml)
