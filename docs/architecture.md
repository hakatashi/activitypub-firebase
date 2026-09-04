# アーキテクチャ

**現時点の**構成を記述する。設計判断の理由は [`adr/`](adr/) を参照。履歴や進捗はここに書かない。

## 全体構成

Firebase Hosting + Cloud Functions (Gen2, Node 22) + Firestore。TypeScript / ESM。
実装は `functions/` 以下にある。`public/` は個人サイト hakatashi.com の git submodule であり、
本プロジェクトのコードではない(→ [ADR-0008](adr/0008-two-domain-split.md))。

Firestore へのクライアントからの読み書きは `firestore.rules` で全面禁止されており、
すべて Cloud Functions (Admin SDK) 経由でアクセスする。

## デプロイされる Function

`functions/src/index.ts` が以下をエクスポートする。

| Function | 種別 | 役割 |
|---|---|---|
| `activitypub` | HTTP | ActivityPub 本体。`hakatashi.com` にマップ |
| `mastodonApi` | HTTP | Mastodon 互換 REST API + OAuth2。`mastodon.hakatashi.com` にマップ |
| `beforeUserCreate` | Auth blocking | Google ログインかつ特定アドレスのみ許可し、`userInfos` を作成 |
| `onStreamWritten` | Firestore trigger | `streams/{id}` の `_meta.objectType(s)` を非正規化 |
| `onStreamCreated` | Firestore trigger | `userInfos` の投稿数・フォロワー数を非正規化 |

## ActivityPub 層

プロトコル実装は `activitypub-express`(apex)に委譲している
(→ [ADR-0002](adr/0002-keep-activitypub-express.md))。apex が署名検証・JSON-LD 処理・
webfinger/nodeinfo・コレクションページングを提供する。

`functions/src/activitypub.ts` が apex のセットアップとルーティングを行う。特筆すべき点:

- Cloud Functions は body を先に読んでしまうため、JSON-LD の body を手動でパースしている。
- HTTP 署名検証を通すため `req.headers.host` を公開ドメインで上書きしている。
- apex はレスポンス送出後に `postWork` を実行する設計だが、Cloud Functions では
  レスポンス後の CPU が保証されない。そのため `express.response.send` をグローバルに
  モンキーパッチし、送出**前**に `postWork` と `apex-inbox`/`apex-outbox` イベントを
  await している。`apex-inbox` リスナーで Follow の自動 Accept を実装している。
- 管理者専用エンドポイント(`/activitypub/createAdmin`, `/createPost`,
  `/publishProfileUpdate`)は `X-Hakatashi-Token` ヘッダで認証する。
- `offlineMode: true` で初期化しており、apex 内蔵の配送ループ(`setInterval` による
  常駐処理)は起動しない。配送は `Store#deliveryEnqueue`(`functions/src/store.ts`)が
  受信者1件につき1つの Cloud Tasks タスクを発行する方式に置き換えている
  (→ [ADR-0003](adr/0003-delivery-via-cloud-tasks.md))。タスクペイロードには
  `actorId` のみを載せ、秘密鍵は含めない。

## ストレージ層

apex の `IApexStore` インターフェースを Firestore で実装した `functions/src/store.ts` が中核。

Firestore のドキュメント ID に URL をそのまま使えないため、
`escapeFirestoreKey` / `unescapeFirestoreKey`(`functions/src/firebase.ts`)で
`%`, `/`, `.` をエスケープしている。

| コレクション | ドキュメント ID | 内容 |
|---|---|---|
| `objects` | エスケープした IRI | actor / Note などの AP オブジェクト。`_meta.privateKey` に秘密鍵 |
| `streams` | エスケープした IRI | アクティビティ。`_meta.collection` が所属コレクションの IRI |
| `contexts` | エスケープした URL | JSON-LD コンテキストのキャッシュ |
| `userInfos` | エスケープした actor IRI | Mastodon 用のユーザーメタ情報(`functions/src/schema.ts`) |
| `clients` / `accessTokens` / `refreshTokens` / `authorizationCodes` / `users` | 自動 ID | OAuth2 用 |

apex は `_meta.collection` を配列として扱うが、Firestore の複合クエリ制約のため
保存時は文字列に正規化している(`normalizeActivity` / `denormalizeActivity`)。

apex のストア抽象では集計ができないため、フォロワー数・投稿数は Firestore Trigger
(`functions/src/denormalizations.ts`)で `userInfos` に非正規化している。
既存データの再計算には `functions/bin/denormalizations.ts` を使う。

## Mastodon API 層

`functions/src/mastodon/` 以下。自前 UI は作らず、Elk などのサードパーティクライアントを
フロントエンドとして使う(→ [ADR-0004](adr/0004-no-custom-ui-use-elk.md))。

| ファイル | 役割 |
|---|---|
| `index.ts` | express アプリ、`beforeUserCreate` |
| `api.ts` | `/api/**` のルーティングと AP オブジェクト → Mastodon エンティティの変換 |
| `oauth.ts` | OAuth2 のエンドポイント。認可画面に FirebaseUI を埋め込む |
| `oauth2Model.ts` | `@node-oauth/oauth2-server` の Firestore バックエンド |
| `instanceInformation.ts` | `/api/v1/instance` と `/api/v2/instance` のレスポンス |

実装状況は [`mastodon-api-coverage.md`](mastodon-api-coverage.md) を参照。
未定義のルートは 501 にフォールバックする。

## デプロイ

`.firebaserc` で本番 `activitypub-firebase` と開発 `activitypub-firebase-dev` の2環境を定義。
`functions/src/firebase.ts` が `projectId` を見てドメインを切り替える。

`.github/workflows/main.yml` が main への push でテスト・lint 実行後、
**両方の環境に同時にデプロイ**する。

## 依存関係

`activitypub-express` / `firebase-functions` / `firebase-admin` /
`@node-oauth/oauth2-server` / `express` が主要な依存。バージョンは `functions/package.json` を参照。
型定義のみ `masto` パッケージを利用している(`CamelToSnake` 型ユーティリティで
camelCase の型定義を snake_case の JSON に変換している)。
