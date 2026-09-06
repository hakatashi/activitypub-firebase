---
name: deploy-firebase
description: activitypub-firebase を Firebase(Functions / Firestore rules・indexes / Hosting)へデプロイする手順。「dev にデプロイして」「dev環境で検証して」「バックフィルスクリプトを実行して」等で使う。本番 `activitypub-firebase` への手動デプロイは絶対に行わず、dev `activitypub-firebase-dev` に対してのみ手動デプロイすること。
---

# Firebase へのデプロイ

`activitypub-firebase`(本番)と `activitypub-firebase-dev`(dev)の2プロジェクト構成
(`.firebaserc`)。**このスキルが対象にするのは dev への手動デプロイのみ。本番への手動デプロイは
行わない**(→ §3)。

## 0. 前提

- `gcloud auth application-default login` 済みで、`activitypub-firebase-dev` への権限がある
  アカウントであること。確認:
  ```bash
  gcloud auth application-default print-access-token >/dev/null && echo OK
  firebase projects:list | grep activitypub-firebase
  ```
- プロジェクト指定は毎回 `-P <project>` を明示する。**`firebase use <project>` で
  アクティブプロジェクトを切り替えると、後続の無関係なコマンドにも影響する**ので使わない。

## 1. dev へのデプロイ(検証目的、PR 作成前に行う)

**dev 環境で検証可能な変更は、PR を作成する前に dev へデプロイして検証する。**
dev は検証専用のデプロイ環境であり、検証のために既存データを破壊してよい
(→ [`AGENTS.md`](../../../AGENTS.md) の「検証」)。

```bash
firebase deploy --only functions,firestore -P activitypub-firebase-dev
```

- `firebase.json` の `predeploy` が `npm --prefix functions run build`(tsc)を自動実行する。
  ビルドエラーがあればここで止まる。
- `firestore` には rules と `firestore.indexes.json` の両方が含まれる。
  「プロジェクトに indexes ファイルにないインデックスが N 個ある」という警告が出ることがあるが、
  **`--force` を付けて削除しない**(過去の実験的インデックスが残っているだけのことが多い。
  削除するなら、それが不要だと確認してから明示的に判断する)。
- Hosting(Elk 配信・リダイレクト)を変更した場合のみ `--only hosting` を追加する。
  通常のバックエンド検証では不要。

デプロイ後、[`docs/runbooks/federation-testing.md`](../../../docs/runbooks/federation-testing.md)
の手順で実際に `mastodon-test.hakatashi.com` との疎通を確認する
(WebFinger/actor、フォロー/Accept、投稿配送など)。`.env` に `REMOTE` / `REMOTE_TOKEN` が
必要(リポジトリルート、gitignore 済み)。

## 2. dev の Firestore に対して一回限りのスクリプトを実行する

`functions/bin/*.ts`(例: `denormalizations.ts`)はバックフィル等の使い捨てスクリプト。
npm scripts には登録されていない。`ts-node` は ESM の `.js` 拡張子解決(`import '../src/x.js'`
が実体は `.ts`)でエラーになるため、代わりに `tsx` を使う。

```bash
cd functions
GCLOUD_PROJECT=activitypub-firebase-dev npx tsx bin/denormalizations.ts
```

- **`GCLOUD_PROJECT` を必ず指定する。** 指定しないと `gcloud config get-value project`
  (別プロジェクトのことがある)が使われうる。
- 調査用に一時スクリプトを `functions/bin/` に置いて実行した場合、恒久的なバックフィルとして
  残す意図がない限り**確認後にファイルを削除する**(コミットしない)。

## 3. 本番へのデプロイ

**行わない。** `main` への push で CI(`.github/workflows/main.yml`)が本番 `activitypub-firebase`
と dev `activitypub-firebase-dev` の両方に自動デプロイする。本番だけを狙って手動デプロイする
経路は用意しない(事故時の切り分けが難しくなるため)。dev で検証が済んだ変更は、PR を経て
`main` にマージすることで本番に反映する。

## 関連

- 連合の疎通確認手順 → [`docs/runbooks/federation-testing.md`](../../../docs/runbooks/federation-testing.md)
- ビルド・テストのローカル実行 → [`docs/runbooks/local-development.md`](../../../docs/runbooks/local-development.md)
