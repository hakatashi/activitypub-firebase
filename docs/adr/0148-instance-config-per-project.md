# ADR-0148: インスタンスの設定を Firebase プロジェクトごとの対応表に持つ

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

ボット用のインスタンスを別の Firebase プロジェクト `activitypub-firebase-bots` で動かす(#315、ADR-0152)。
ドメインは `functions/src/firebase.ts` で `projectId === 'activitypub-firebase'` の二択で決まっており、
新しいプロジェクトは dev のドメインになってしまう。主 actor の名前や Google ログインを許すメールアドレスも
`localActor.ts` の定数で、プロジェクトによって変えられない。

## 決定

1. `functions/src/instanceConfig.ts` に `projectId → InstanceConfig` の対応表を置く。項目は
   ActivityPub のドメイン、Mastodon API のドメイン、主 actor(username・表示名・紹介文・アイコン・type・
   ログインを許すメールアドレス)、連絡先、ボット機能の設定(ADR-0149、ADR-0150)。
2. 対応表にない projectId(テストのワーカーごとの `activitypub-firebase-dev-wN` など)は dev の設定にする。
3. `firebase.ts` の `domain` / `mastodonDomain` と `localActor.ts` の `LOCAL_*` はこの設定から作る。
   それらを参照している既存のコードは書き換えない。
4. ボット用インスタンスの主 actor は、人が使わないインスタンス actor(`instance`、type `Application`)にする。
   ログインを許すメールアドレスは `null` にし、`beforeUserCreate` は全員を拒否する。
5. `instanceConfig.ts` は副作用を持たず、何も import しない(ADR-0078 と同じく、テストや bin から読める)。

## 理由

- 主 actor の定数は射影・GET の署名(ADR-0098)・インスタンス情報など約80箇所から参照されている。
  値だけをプロジェクトごとに変えれば、参照する側は変えずに済む。
- 環境変数(`defineString` など)で渡す案も考えた。モジュールの読み込み時に定数として必要になる値が多く、
  `.env` をプロジェクトごとに管理する手間も増えるので採らない。
- ボット用インスタンスで主 actor を持たない案は、上の参照をすべて「主 actor がいない場合」に対応させる
  必要があり、変更が大きい。射影などは誰も読まないインスタンス actor に向くだけで、害はない。

## 結果

- 本番と dev の挙動は変わらない。
- 新しいプロジェクトを足すときは、対応表に1件足す。

## 参照

- 関連 ADR: [ADR-0005](0005-single-user-multi-ready-data-model.md)、[ADR-0008](0008-two-domain-split.md)、[ADR-0077](0077-isolate-test-firestore-by-worker-project-id.md)、[ADR-0078](0078-consolidate-local-actor-configuration.md)
- 関連 Issue: [#315](https://github.com/hakatashi/activitypub-firebase/issues/315)
