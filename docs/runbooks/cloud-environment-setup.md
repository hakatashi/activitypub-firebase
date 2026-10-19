# Claude Code Cloud Environment セットアップ手順書

このランブックでは、[Claude Code Cloud Environments](https://code.claude.com/docs/en/cloud-environments) (Web 版 Claude Code、モバイルアプリ、デスクトップアプリ、`claude --cloud` 等) で本プロジェクト (`activitypub-firebase`) を不自由なく開発するための環境作成手順を説明します。

---

## 概要

Claude Code のクラウド環境は Ubuntu 24.04 (x86_64) VM 上で動作します。
本プロジェクトの開発（TypeScript ビルド、oxlint / oxfmt、Firestore エミュレータを用いた 880 件超のテスト、Git サブモジュールの参照、dev 環境へのデプロイ・連合検証）をクラウド上でもローカルと同様に行えるよう、以下の設定を適用します。

| 設定項目 | 内容 | 役割 |
|---|---|---|
| **Environment Name** | `activitypub-firebase` | 環境の識別名 |
| **Network access** | `Full` (推奨) または `Custom` | dev 環境や自前テストサーバー (`*.hakatashi.com`) への通信許可 |
| **Network secrets** | Mastodon / Misskey / dev 管理者用トークン | Agent Proxy 経由での安全な認証ヘッダー付与 |
| **Environment variables** | `.claude/cloud-environment/env.example` の内容 | タイムアウト延長、dev プロジェクト固定、エンドポイント定義 |
| **Setup script** | `.claude/cloud-environment/setup.sh` の内容 | `gcloud`, `firebase-tools`, サブモジュール, `npm ci`, エミュレータの事前キャッシュ (初回5分以内) |

---

## 新規環境の作成手順

1. ブラウザで [claude.ai/code](https://claude.ai/code) にアクセスし、新しいセッションの開始画面を開きます。
2. 入力欄下部にある環境セレクター (デフォルトでは **Default** と表示) をクリックします。
3. メニュー最下部の **New environment** を選択し、**New environment** ダイアログを開きます。
4. 以下のセクションに従って各フィールドを入力します。

---

## 各フィールドの入力内容

### 1. Name
```text
activitypub-firebase
```

### 2. Network access
- **Full** を選択することを強く推奨します。
  - *※ 組織ポリシー等で Custom に制限する場合は、以下のように設定します:*
    - **Also include default list of common package managers** を **有効 (ON)** にする
    - **Allowed domains** に以下を入力:
      ```text
      activitypub-dev.hakatashi.com
      mastodon-dev.hakatashi.com
      mastodon-test.hakatashi.com
      misskey-test.hakatashi.com
      *.hakatashi.com
      hakatashi.com
      ```

### 3. Environment variables
`.claude/cloud-environment/env.example` の内容をコピー＆ペーストします。

```text
# --- Timeout Configurations ---
BASH_DEFAULT_TIMEOUT_MS=600000
BASH_MAX_TIMEOUT_MS=1800000

# --- Node & System Configurations ---
JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
PATH=/usr/local/bin:/usr/bin:/bin:/opt/node22/bin:/root/.cache/firebase/bin

# --- GCP / Firebase Project Configurations ---
GCLOUD_PROJECT=activitypub-firebase-dev
PROJECT_ID=activitypub-firebase-dev
FIREBASE_PROJECT=activitypub-firebase-dev

# --- Endpoints for Development & Federation Testing ---
DEV=https://activitypub-dev.hakatashi.com
ACTOR=https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi
REMOTE=https://mastodon-test.hakatashi.com
MISSKEY_REMOTE=https://misskey-test.hakatashi.com

# --- Authentication & API Tokens (必要に応じて設定) ---
REMOTE_TOKEN=
HAKATASHI_TOKEN=
MASTODON_DEV_TOKEN=
MISSKEY_REMOTE_TOKEN=

# --- Service Account Key (for GCP / Firebase CLI deployment) ---
GCP_SA_KEY=
```

> [!TIP]
> - `BASH_DEFAULT_TIMEOUT_MS=600000` (10分): `npm --prefix functions test` (Firestore エミュレータ起動＋全テスト実行) は完了まで数分かかるため、タイムアウトを延長しています。
> - `GCLOUD_PROJECT=activitypub-firebase-dev`: 本番 (`activitypub-firebase`) への誤操作を防ぎ、常に dev 環境をターゲットとします。
> - `NODE_ENV` は設定しないでください。vitest は `NODE_ENV` が未設定のときだけ `test` を入れるため、`development` などを入れるとテスト用の分岐 (`functions/src/webfinger.ts` など) が無効になり、モックサーバーを使うテストが失敗します。
> - `GCP_SA_KEY` には `activitypub-firebase-dev` のサービスアカウントキー JSON を1行で設定します。クラウドセッションから dev への `firebase deploy` や `gcloud secrets` の参照に使います。取得手順は後述の「GCP_SA_KEY の用意」を参照してください。

#### GCP_SA_KEY の用意

dev プロジェクト専用のサービスアカウントを作り、そのキー JSON を `GCP_SA_KEY` に設定します。
**本番 (`activitypub-firebase`) には一切権限を与えません。** 本番へは `main` への push による CI だけがデプロイします
(→ `deploy-firebase` skill §3)。

1. サービスアカウントを作成します。

   ```bash
   gcloud iam service-accounts create claude-cloud-deployer \
     --project=activitypub-firebase-dev \
     --display-name="Claude Code Cloud deployer"
   ```

2. 次のロールを `activitypub-firebase-dev` に付与します。

   | ロール | 用途 |
   |---|---|
   | `roles/firebase.admin` | Hosting、Firestore の rules / indexes、Storage の rules のデプロイ |
   | `roles/cloudfunctions.admin` | Functions のデプロイ |
   | `roles/run.admin` | Functions v2 の実体 (Cloud Run) の更新、`gcloud run services update` |
   | `roles/cloudbuild.builds.editor` | Functions v2 のビルド |
   | `roles/artifactregistry.writer` | ビルドしたイメージの push |
   | `roles/cloudtasks.admin` | `onTaskDispatched` のキュー作成、`gcloud tasks list` |
   | `roles/cloudscheduler.admin` | `onSchedule` のジョブ作成 |
   | `roles/secretmanager.admin` | `defineSecret` のバインドと `gcloud secrets` の参照 |
   | `roles/iam.serviceAccountUser` | ランタイム SA を関数に紐付ける |
   | `roles/datastore.owner` | バックフィルスクリプトの Firestore 読み書き、`gcloud firestore fields ttls list` |
   | `roles/storage.objectAdmin` | メディア関連スクリプトでの Storage 操作 |
   | `roles/logging.viewer` | `gcloud logging read` |
   | `roles/serviceusage.serviceUsageConsumer` | firebase CLI の API 利用 |

   ```bash
   SA=claude-cloud-deployer@activitypub-firebase-dev.iam.gserviceaccount.com
   for role in roles/firebase.admin roles/cloudfunctions.admin roles/run.admin \
     roles/cloudbuild.builds.editor roles/artifactregistry.writer \
     roles/cloudtasks.admin roles/cloudscheduler.admin roles/secretmanager.admin \
     roles/iam.serviceAccountUser roles/datastore.owner roles/storage.objectAdmin \
     roles/logging.viewer roles/serviceusage.serviceUsageConsumer; do
     gcloud projects add-iam-policy-binding activitypub-firebase-dev \
       --member="serviceAccount:$SA" --role="$role" --condition=None >/dev/null
   done
   ```

3. キーを発行し、1行に圧縮します。

   ```bash
   gcloud iam service-accounts keys create key.json --iam-account="$SA"
   jq -c . key.json
   shred -u key.json
   ```

4. 出力を `GCP_SA_KEY` に設定します。**値は必ずシングルクォートで囲みます**
   (`GCP_SA_KEY='{"type":"service_account",...}'`)。囲まないと `private_key` 内の `\n` などが
   解釈されて JSON が壊れ、認証に失敗します。

組織ポリシー `iam.disableServiceAccountKeyCreation` が有効だとキーを作れません。
キーが漏えいした疑いがあるときは `gcloud iam service-accounts keys delete` で失効させて作り直します。

このロールの組み合わせで、dev への `firebase deploy --only functions,firestore,storage`
(全 Functions・rules・indexes の更新)が通ることを確認済みです。`gcloud secrets` / `gcloud tasks` /
`gcloud logging read` / `gcloud run services describe` / `gcloud firestore fields ttls list` も実行でき、
本番 `activitypub-firebase` に対する操作は権限エラーになります。
`firebase deploy --only hosting` と `gcloud run services update` は未確認です。

### 4. Setup script
`.claude/cloud-environment/setup.sh` の内容をそのまま貼り付けます。

```bash
#!/bin/bash
set -u

echo "=== [Setup] Starting Claude Code Cloud Environment setup for activitypub-firebase ==="
start_time=$(date +%s)

# 1. Ensure basic utilities and Google Cloud CLI (gcloud)
echo "=== [Setup] Checking Google Cloud CLI (gcloud) ==="
if ! command -v gcloud &> /dev/null; then
  echo "Installing google-cloud-cli via apt..."
  apt-get update -qq
  apt-get install -y -qq apt-transport-https ca-certificates gnupg curl
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg --yes 2>/dev/null || true
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -qq
  apt-get install -y -qq google-cloud-cli || {
    echo "Warning: apt-get install google-cloud-cli failed. Continuing..."
  }
else
  echo "gcloud CLI is already installed: $(gcloud --version 2>/dev/null | head -n 1)"
fi

# 1b. Configure Google Cloud ADC if service account key is provided.
#    Runs right after gcloud is installed so that the time limit cannot cut it off. scripts/cloud_session_start.sh repeats it on every session start.
if [ -n "${GCP_SA_KEY:-}" ]; then
  echo "=== [Setup] Configuring Google Cloud Service Account ==="
  ADC=/root/.config/gcloud/application_default_credentials.json
  mkdir -p /root/.config/gcloud
  (umask 077 && printf '%s' "$GCP_SA_KEY" > "$ADC")
  if command -v gcloud &> /dev/null; then
    gcloud auth activate-service-account --key-file="$ADC" --quiet \
      || echo "Warning: gcloud auth activate-service-account failed (check GCP_SA_KEY)."
  fi
fi

# 2. Install firebase-tools globally
echo "=== [Setup] Checking firebase-tools ==="
if ! command -v firebase &> /dev/null; then
  echo "Installing firebase-tools globally..."
  npm install -g firebase-tools || echo "Warning: global firebase-tools install failed. functions/node_modules will provide it."
else
  echo "firebase-tools is already installed: $(firebase --version 2>/dev/null)"
fi

# 3. Initialize Git submodules (shallow clone to save time and bandwidth)
echo "=== [Setup] Initializing git submodules (depth 1) ==="
TARGET_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
cd "$TARGET_DIR" || cd /root

if [ -d ".git" ]; then
  git submodule update --init --recursive --depth 1 || {
    echo "Warning: shallow submodule checkout failed. Retrying standard checkout..."
    git submodule update --init --recursive || echo "Warning: git submodule update encountered errors. Continuing..."
  }
fi

# 4. Install npm dependencies in functions/
echo "=== [Setup] Installing npm dependencies in functions/ ==="
if [ -d "$TARGET_DIR/functions" ]; then
  cd "$TARGET_DIR/functions"
  npm ci || {
    echo "Warning: npm ci failed. Falling back to npm install..."
    npm install
  }

  mkdir -p node_modules
  sha256sum package.json package-lock.json > node_modules/.install_pkgs.sha256 2>/dev/null || true
fi

# 5. Pre-download Firestore emulator JAR (caches ~130MB emulator)
echo "=== [Setup] Pre-caching Firestore emulator ==="
cd "$TARGET_DIR" || cd /root
if command -v firebase &> /dev/null; then
  firebase setup:emulators:firestore || echo "Warning: firebase setup:emulators:firestore failed. It will be downloaded on first test run."
elif [ -f "$TARGET_DIR/functions/node_modules/.bin/firebase" ]; then
  "$TARGET_DIR/functions/node_modules/.bin/firebase" setup:emulators:firestore || echo "Warning: local firebase setup:emulators:firestore failed."
fi

# 6. Pre-build functions (tsc)
echo "=== [Setup] Pre-building functions ==="
if [ -d "$TARGET_DIR/functions" ]; then
  cd "$TARGET_DIR/functions"
  npm run build || echo "Warning: initial build failed. Continuing..."
fi

elapsed=$(( $(date +%s) - start_time ))
echo "=== [Setup] Setup completed in ${elapsed}s ==="
exit 0
```

> [!IMPORTANT]
> - セットアップスクリプトは、初回セッション起動時に root 権限で約 1〜2 分で完了します。
> - 完了後、ファイルシステム全体がスナップショットとしてキャッシュされるため、2回目以降のセッション起動は数秒で完了します。

### 5. Network secrets
環境作成後、または環境編集ダイアログの **Network secrets** セクションで **Add secret** をクリックして以下の4件を登録します。

| Secret Name | Allowed websites | Type | Header Name | Prefix | 設定値 |
|---|---|---|---|---|---|
| `Mastodon Test Token` | `mastodon-test.hakatashi.com` | Bearer | `Authorization` | `Bearer` | `REMOTE_TOKEN` |
| `ActivityPub Dev Admin Token` | `activitypub-dev.hakatashi.com` | Custom / Bearer | `X-Hakatashi-Token` | *(なし)* | `HAKATASHI_TOKEN` |
| `Mastodon Dev Token` | `mastodon-dev.hakatashi.com` | Bearer | `Authorization` | `Bearer` | `MASTODON_DEV_TOKEN` |
| `Misskey Test Token` | `misskey-test.hakatashi.com` | Bearer | `Authorization` | `Bearer` | `MISSKEY_REMOTE_TOKEN` |

---

## 動作確認 (セッション開始後のチェック)

クラウドセッションを開始後、エージェントまたはプロンプトから以下のコマンドを実行して正常性を確認します。

1. **基本ツールと環境変数の確認**:
   ```bash
   node -v                 # v22.x
   java -version           # OpenJDK 21
   firebase --version      # Firebase CLI
   echo $GCLOUD_PROJECT    # activitypub-firebase-dev
   ```

2. **サブモジュールの確認**:
   ```bash
   git submodule status
   ```

3. **型チェック・リント・フォーマット確認**:
   ```bash
   npm --prefix functions run typecheck
   npm --prefix functions run lint
   npm --prefix functions run format:check
   ```

4. **テスト実行 (Firestore エミュレータ連携)**:
   ```bash
   npm --prefix functions run test:changed   # 変更部分のみ
   npm --prefix functions test               # 全テスト実行
   ```

5. **外部接続テスト (Network Secrets / Allowed Domains)**:
   ```bash
   # Mastodon テストサーバーへの疎通
   curl -s -H "Accept: application/json" https://mastodon-test.hakatashi.com/api/v1/instance | jq .title

   # dev 環境のアクター確認
   curl -s -H "Accept: application/activity+json" https://activitypub-dev.hakatashi.com/activitypub/u/hakatashi | jq .id
   ```
