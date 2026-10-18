# Claude Code のクラウドセッションで作業するときの注意

Claude Code のクラウドセッション(claude.ai/code・モバイル・デスクトップ・`claude --cloud`)で
このリポジトリを扱うエージェント向けの注意点。環境の作り方は人間向けの
[`cloud-environment-setup.md`](cloud-environment-setup.md) にあり、エージェントが読む必要はない。

## セッションの性質

- コンテナは使い捨てで、一定時間操作がないと回収される。**残したい変更は commit して push する。**
- `main` への push は本番と dev に自動デプロイされる。作業は指定されたブランチで行う。
- 環境変数 `CLAUDE_CODE_REMOTE=true` のときクラウドセッションである。

## 開始時に点検すること

セットアップスクリプトの時点ではリポジトリがまだ反映されていないことがあり、
サブモジュールや `functions/node_modules` が欠けた状態で始まる場合がある。
これは `SessionStart` hook(`scripts/cloud_session_start.sh`)が補うが、念のため確認する。

```bash
git submodule status | grep '^-'   # 何か出たら未取得
ls functions/node_modules >/dev/null || echo missing
```

欠けていたら手で補う(それぞれ 30 秒ほど)。

```bash
git submodule update --init --recursive --depth 1
npm --prefix functions ci
```

## テスト

- `npm --prefix functions test` は Firestore エミュレータの起動を含めて 2〜3 分かかる。
  バックグラウンドで実行して結果を待つとよい。エミュレータの JAR はセットアップ時にキャッシュ済み。
- **`NODE_ENV` を設定しない。** vitest は `NODE_ENV` が未設定のときだけ `test` を入れる。
  `development` などが入っていると `functions/src/webfinger.ts` などのテスト用分岐が無効になり、
  ローカルのモックサーバー(`http://127.0.0.1:<port>`)を使うテストが 20 件以上まとめて落ちる。
  WebFinger・リモートアクター取得・検索まわりのテストだけが落ちたら、まず `echo "${NODE_ENV-unset}"` を確認する。
  環境変数に入ってしまっている場合は `env -u NODE_ENV npm --prefix functions test` で回避し、ユーザーに伝える。

## ネットワークと認証

- 外向きの通信は Agent Proxy を経由する(`HTTPS_PROXY`)。TLS 検証を無効にしたり、
  `HTTPS_PROXY` を外したりしない。
- 次のホストへのリクエストには、プロキシが Network secrets のトークンを自動で付ける。
  curl に認証ヘッダを書かなくても認証が通る。

  | ホスト | 付くヘッダ | 中身 |
  |---|---|---|
  | `activitypub-dev.hakatashi.com` | `X-Hakatashi-Token` | dev の管理者エンドポイント用 |
  | `mastodon-dev.hakatashi.com` | `Authorization: Bearer` | dev の Mastodon API(本プロジェクト)用 |
  | `mastodon-test.hakatashi.com` | `Authorization: Bearer` | 連合相手の Mastodon(`admin`)用 |
  | `misskey-test.hakatashi.com` | `Authorization: Bearer` | 連合相手の Misskey(`admin`)用 |

- runbook の手順には `$HAKATASHI_TOKEN` や `$REMOTE_TOKEN` を直接参照するものがあるため、
  同じ値が環境変数にも入っていることがある(空でもプロキシ経由の認証は通る)。**トークンの値を echo・ログ・コミット・PR 本文に出さない。**
  有無を確かめるときは長さだけを見る(`echo ${#REMOTE_TOKEN}`)。
- `DEV` / `ACTOR` / `REMOTE` / `MISSKEY_REMOTE` は環境変数で定義済み。
  [`federation-testing.md`](federation-testing.md) の `.env` を作る手順は飛ばしてよい。

## GCP / Firebase

- サービスアカウントキー(環境変数 `GCP_SA_KEY`)が設定されていれば、セットアップスクリプトが
  ADC(`/root/.config/gcloud/application_default_credentials.json`)と `gcloud` に登録する。
  使えるかどうかは次で確かめる。

  ```bash
  gcloud auth list
  gcloud auth application-default print-access-token >/dev/null && echo OK
  ```

- 認証できないときは、dev へのデプロイ・`gcloud secrets`・バックフィルスクリプトは実行できない。
  ユーザーにそう伝え、実行したことにしたり結果を推測で埋めたりしない。
- **`.firebaserc` の `default` は本番(`activitypub-firebase`)である。** 環境変数で
  `GCLOUD_PROJECT=activitypub-firebase-dev` にしてあるが、firebase コマンドには必ず
  `-P activitypub-firebase-dev` を付ける。デプロイは `deploy-firebase` skill に従う。

## GitHub

- `gh` CLI は入っているが認証されていない。Issue・PR の操作は GitHub の MCP ツールで行う。
- git の fetch / push はセッションの認証で通る。
