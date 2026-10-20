# Claude Code Cloud Environment: Network Access & Secrets

このドキュメントは、[Claude Code Cloud Environments](https://code.claude.com/docs/en/cloud-environments) の **Network access** および **Network secrets** 設定画面に入力する推奨構成をまとめています。

---

## 1. Network access (ネットワークアクセスレベル)

### 推奨設定: `Full` または `Custom`

| 項目 | 設定値 / 推奨値 | 理由 |
|---|---|---|
| **Network access** | **Full** (強く推奨) または **Custom** | `activitypub-dev.hakatashi.com` や自前テストサーバー (`mastodon-test.hakatashi.com`, `misskey-test.hakatashi.com`) は、デフォルトの **Trusted** 許可リストに含まれていないため。 |

#### `Custom` を選択する場合の設定内容
- **Also include default list of common package managers**: **チェックを有効 (ON)** にする（npm, GitHub, Google Cloud APIs への通信を維持するため）。
- **Allowed domains**: 以下のドメインを1行ずつ入力します。
  ```text
  activitypub-dev.hakatashi.com
  mastodon-dev.hakatashi.com
  mastodon-test.hakatashi.com
  misskey-test.hakatashi.com
  *.hakatashi.com
  hakatashi.com
  ```

---

## 2. Network secrets (ネットワークシークレット)

Cloud Environment の Network Secrets は、Anthropic の Agent Proxy が指定ホストへの送信 HTTP リクエストに対して安全に認証ヘッダーを付与する仕組みです。VM 内のファイルやログにトークンが残らないため安全性が向上します。

以下の 4 つのシークレットを登録することを推奨します（値は各自のトークンに置き換えてください）。

### シークレット 1: Mastodon テストサーバー用 API トークン
* **Name**: `Mastodon Test Token`
* **Allowed websites**: `mastodon-test.hakatashi.com`
* **Secret type**: `Bearer`
* **Custom headers**:
  * Name: `Authorization`
  * Prefix: `Bearer`
  * Value: `<REMOTE_TOKEN の値>`
* **用途**: `docs/runbooks/federation-testing.md` に従い、相手側サーバー (`mastodon-test.hakatashi.com`) のフォロー、タイムライン、アカウント情報を CLI (curl 等) から検証する際の認証。

### シークレット 2: ActivityPub dev 管理者エンドポイント用トークン
* **Name**: `ActivityPub Dev Admin Token`
* **Allowed websites**: `activitypub-dev.hakatashi.com`
* **Secret type**: `Bearer` (または Custom Header)
* **Custom headers**:
  * Name: `X-Hakatashi-Token`
  * Prefix: *(空欄 / なし)*
  * Value: `<HAKATASHI_TOKEN の値>`
* **用途**: dev 環境の管理者エンドポイント (`/activitypub/createPost`, `/activitypub/publishProfileUpdate`, `/activitypub/deliveries/failed` 等) を叩く際の認証。

### シークレット 3: dev Mastodon 互換 API 用 Bearer トークン
* **Name**: `Mastodon Dev Token`
* **Allowed websites**: `mastodon-dev.hakatashi.com`
* **Secret type**: `Bearer`
* **Custom headers**:
  * Name: `Authorization`
  * Prefix: `Bearer`
  * Value: `<MASTODON_DEV_TOKEN の値>`
* **用途**: dev 環境の Mastodon API (`/api/v1/timelines/home`, `/api/v1/statuses` 等) に対するクライアント検証用認証。

### シークレット 4: Misskey テストサーバー用 API トークン
* **Name**: `Misskey Test Token`
* **Allowed websites**: `misskey-test.hakatashi.com`
* **Secret type**: `Bearer`
* **Custom headers**:
  * Name: `Authorization`
  * Prefix: `Bearer`
  * Value: `<MISSKEY_REMOTE_TOKEN の値>`
* **用途**: Misskey 連合テスト用インスタンスの操作用。

---

## 3. 注意点 (Network Secrets と環境変数の使い分け)

- **Agent Proxy による付与**: Network Secrets は、セッション内からホスト宛てに HTTP/HTTPS リクエストが飛ぶときに Proxy 経由で付与されます。
- **スクリプトによるトークンの参照**: `functions/bin/*.ts` などの Node.js スクリプトやテストコードが `process.env.REMOTE_TOKEN` などを直接読み取って自前で署名・パラメータ・ペイロードを組み立てる場合、Network Secrets の値はプロセス内の環境変数としては注入されません。
- **両方の併用**: スクリプト実行の利便性を保つため、環境変数 (`env.example` の `REMOTE_TOKEN` 等) にも同じ値を設定しておくか、環境変数が未設定でも動作するようフォールバックを用意することを推奨します。
