# ADR-0152: ボット用インスタンスは別の Firebase プロジェクトで、同じリポジトリから同じ Functions をデプロイする

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

ボット(ADR-0149)を本アカウントと同じインスタンスに置くと、ボットの不具合や Cloud Tasks・Firestore の
負荷が本アカウントに波及する。ボットのドメインがブロックされたときに、本アカウントが巻き込まれるのも避けたい。

## 決定

1. ボット用インスタンスは Firebase プロジェクト `activitypub-firebase-bots`、ドメイン
   `bots.activitypub.hakatashi.com` で動かす。ActivityPub と Mastodon API を同じドメインで出す。
2. リポジトリは共有し、Functions は全プロジェクトで同じものを export する。ボット専用の Functions はない
   (投稿のロジックは外部にある、ADR-0151)。機能の違いはインスタンス設定(ADR-0148)で切り替える。
   `beforeUserCreate` を deploy できるよう、このプロジェクトでも Authentication を有効にする。
3. Hosting は3つ目のターゲット `bots` にする。public は個人サイトではなく最小限の `hosting/bots/` にし、
   rewrites は `activitypub` と `mastodon` の2ターゲットの和にする。`/` からのリダイレクトはしない。
4. 専用の dev プロジェクトは作らない。複数 actor・投稿 API・承認ポリシーは既存の dev でボット機能を
   有効にして確かめ、ボット用インスタンスに固有の部分(単一ドメインの Hosting など)は初回の手動デプロイで確かめる。
5. CI のデプロイ対象には、初回の手動デプロイと疎通の確認が済んでから加える。

## 理由

- 同じプロジェクトでドメインだけを分けると、プロセス全体の定数である `domain` と apex をマルチテナントにする
  必要がある。リポジトリをフォークすると、apex を含む連合まわりの修正を二重に保守することになる。
- Mastodon のドメインブロックは親ドメインを含めて判定する(`DomainBlock.rule_for`)ので、
  `bots.activitypub.hakatashi.com` がブロックされても `hakatashi.com` は影響を受けない。
- ボット用インスタンスは、本番の `hakatashi.com` のように個人サイトと相乗りする必要がないので、
  ADR-0008 のようにドメインを分けない。

## 結果

- main への push で本番・dev・ボット用の3つにデプロイされる。

## 参照

- 関連 ADR: [ADR-0008](0008-two-domain-split.md)、[ADR-0132](0132-serialize-deploys.md)、[ADR-0148](0148-instance-config-per-project.md)
- 関連 Issue: [#315](https://github.com/hakatashi/activitypub-firebase/issues/315)
