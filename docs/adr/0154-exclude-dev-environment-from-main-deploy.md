# ADR-0154: main push 時の自動デプロイ先から dev 環境を除外する

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

`main` への push では、本番環境 (`activitypub-firebase`)、dev 環境 (`activitypub-firebase-dev`)、ボット用環境 (`activitypub-firebase-bots`) に自動デプロイを行っていた。
しかし dev 環境は開発者が手動デプロイし、実験や検証、テストデータの破壊的変更を行うための検証環境である。main への push のたびに dev 環境へ自動デプロイされると、進行中の手動検証作業や検証データが意図せず上書きされてしまう。

## 決定

1. `.github/workflows/main.yml` の `deploy-firebase` および `deploy-hosting` の matrix から `activitypub-firebase-dev` を除外する。
2. `main` push 時の自動デプロイ先を本番環境 (`activitypub-firebase`) とボット用環境 (`activitypub-firebase-bots`) のみに限定する。
3. デプロイ後のスモークテスト `smoke-test-dev` を本番環境向けのスモークテスト `smoke-test` に変更し、デプロイ後の本番 actor に対する適合性を検証する (ADR-0043 を supersede)。

## 理由

- dev 環境は PR 前の疎通検証や一時的な動作確認を行う場であり、自動デプロイの対象から切り離すことで、作業中の検証状態を安定して維持できる。
- main への push でデプロイされるのは本番環境とボット用環境のみとなるため、デプロイ後のスモークテストも本番環境に対して実行することで、本番デプロイの正常性を早期検知できる。
- デプロイ対象が減るため、CI の実行時間短縮にも寄与する。

## 結果

- dev 環境へのデプロイは手動 (`firebase deploy -P dev`) でのみ行われるようになる。
- main への push 時には本番環境とボット用環境のみが直列にデプロイされ、本番環境に対してスモークテストが実行される。

## 参照

- 関連 ADR: [[0043-smoke-test-dev-with-activitypub-testing]] (superseded), [[0132-serialize-deploys]], [[0152-bots-instance-in-separate-project]]
- 関連ドキュメント: `docs/runbooks/local-development.md`, `AGENTS.md`, `.claude/skills/deploy-firebase/SKILL.md`
