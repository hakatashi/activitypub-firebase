# ADR-0122: 連合の検証相手として Misskey を自前ホストする

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

pawoo.net のフォロワーのうち一定数が misskey.io やその他 Misskey 系サーバーに存在する。
しかしこれまで連合の検証相手は自前ホストの Mastodon([ADR-0014](0014-self-hosted-federation-test-instance.md))のみで、
Misskey との相互運用は一度も確認していなかった。

Misskey は inline `@context` や独自拡張、`AccountMoveService` による厳格な `alsoKnownAs` 検証など、
Mastodon と異なる AP 挙動を持つ。公開インスタンスで試すと失敗時にフォロワーを失うリスクがあるため、
移行(Phase 5)に先立ち相手側ログを読める検証環境が必要である。

## 決定

**検証用の Misskey を自前でホストし、連合の検証相手に加える(ADR-0014 を拡張する)。**

- ドメインは `misskey-test.hakatashi.com`。ホストは自宅サーバー(HakataMatrix)で、既存の nginx + certbot 構成に相乗りする。
- 公式イメージ `misskey/misskey:2025.4.1`(misskey.io 近似)と公式 Docker Compose 構成を使う。
- 既存の Mastodon(ポート 3000)との競合を避けるため、ホスト側はポート 3001 をリバースプロキシする。
- 外部の公開インスタンスを検証に使わない理由は ADR-0014 と同じ。
- 構築と運用の手順は [`federation-testing.md`](../runbooks/federation-testing.md) に置く。

## 理由

- 相手側のコンテナログや PostgreSQL を直接読めるため、HTTP 署名検証や JSON-LD 解釈のエラーを正確に特定できる。
- アカウントやキャッシュの作成・削除を気兼ねなく繰り返せる。
- misskey.io (2025.4.1-io 系)に近い公式バージョンを使うことで、フォロワーの多数派を占める環境の挙動を忠実に再現できる。

## 結果

- Misskey を相手取った WebFinger、Follow/Accept、投稿・リアクション・Renote、アカウント移行(Move)の検証が可能になる。
- HakataMatrix 上で Mastodon と Misskey の2システムを常時あるいは適宜稼働させるため、ディスクとリソースの管理が必要になる。

## 参照

- 関連 Issue: [#264](https://github.com/hakatashi/activitypub-firebase/issues/264), [#10](https://github.com/hakatashi/activitypub-firebase/issues/10)
- 関連 ADR: [ADR-0014](0014-self-hosted-federation-test-instance.md)
