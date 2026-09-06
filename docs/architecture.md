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
| `onStreamWritten` | Firestore trigger | `streams/{id}` の `_meta.index`(検索用インデックス)を非正規化 |
| `onStreamCreated` | Firestore trigger | `userInfos` の投稿数・フォロワー数を非正規化 |
| `deliveryTask` | Cloud Tasks (`onTaskDispatched`) | 配送ワーカー。受信者1件への配送を1回実行する |
| `pingTask` | Cloud Tasks (`onTaskDispatched`) | Cloud Tasks の疎通確認用。`GET /activitypub/pingTaskQueue` から発行する |

## ActivityPub 層

プロトコル実装は `activitypub-express`(apex)に委譲している
(→ [ADR-0002](adr/0002-keep-activitypub-express.md))。apex が署名検証・JSON-LD 処理・
webfinger/nodeinfo・コレクションページングを提供する。

apex インスタンスの生成は `functions/src/apex.ts` にある(`functions/src/tasks.ts` からも
import されるため、`functions/src/activitypub.ts` との import サイクルを避けて分離している)。
`functions/src/activitypub.ts` はそれを使って express のルーティングを行う。特筆すべき点:

- Cloud Functions は body を先に読んでしまうため、JSON-LD の body を手動でパースしている。
- HTTP 署名検証を通すため `req.headers.host` を公開ドメインで上書きしている。
- apex はレスポンス送出後に `postWork` を実行する設計だが、Cloud Functions では
  レスポンス後の CPU が保証されない。そのため `functions/src/postWork.ts` の
  `runPostWorkBeforeSend` ミドルウェアがリクエストごとに `res.send` を差し替え、
  送出**前**に `postWork` と `apex-inbox`/`apex-outbox` イベントを await している
  (→ [ADR-0013](adr/0013-scoped-postwork-middleware.md))。所要時間は
  `postWorkCompleted` ログに出る。`apex-inbox` リスナーで Follow の自動 Accept を実装している。
- 管理者専用エンドポイント(`/activitypub/createAdmin`, `/createPost`,
  `/publishProfileUpdate`, `/pingTaskQueue`, `/deliveries/failed`, `/deliveries/resend`)は
  `X-Hakatashi-Token` ヘッダで認証する。
- `offlineMode: true` で初期化しており、apex 内蔵の配送ループ(`setInterval` による
  常駐処理)は起動しない。配送は `Store#deliveryEnqueue`(`functions/src/store.ts`)が
  受信者1件につき1つの Cloud Tasks タスクを発行する方式に置き換えている
  (→ [ADR-0003](adr/0003-delivery-via-cloud-tasks.md))。タスクペイロードは
  `actorId` / `body` / `address` の3つで、**秘密鍵は含めない。**
  発行されたタスクは `functions/src/tasks.ts` の
  `deliveryTask`(`onTaskDispatched`)が処理する。`actorId` から
  `store.getObject(actorId, true)` で秘密鍵を引き、`apex.deliver` で配送する。
  401/403/404/410 とその他の 4xx は恒久失敗としてリトライせず破棄し、5xx と
  ネットワークエラーは throw して Cloud Tasks のリトライ(`retryConfig`)に委ねる。
  配送のたびに結果を `deliveries` コレクションへ記録し、`GET /activitypub/deliveries/failed`
  で一覧、`POST /activitypub/deliveries/resend` で再送できる(→ [ADR-0012](adr/0012-delivery-results-in-firestore.md))。

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
| `deliveries` | エスケープした `アクティビティ ID + 宛先` | 配送結果(→ [ADR-0012](adr/0012-delivery-results-in-firestore.md)) |
| `userInfos` | エスケープした actor IRI | Mastodon 用のユーザーメタ情報(`functions/src/schema.ts`) |
| `clients` / `accessTokens` / `refreshTokens` / `authorizationCodes` / `users` | 自動 ID | OAuth2 用 |

apex は `_meta.collection` を「アクティビティが所属するコレクションの集合」として扱い、
Firestore 上でもそのまま配列として保存する。コレクション単体での所属判定
(`getStream`/`getStreamCount`)は `array-contains` クエリで行い
(→ [ADR-0017](adr/0017-meta-collection-as-array.md))、他の条件と組み合わせる検索は
後述の `_meta.index` を使う(→ [ADR-0021](adr/0021-meta-index-as-maps.md))。

### `_meta` メタデータフィールド

`objects` および `streams` コレクション内のドキュメントには、内部管理用のメタデータとして `_meta` オブジェクトが付与される。apex は JSON-LD 出力時に `_` で始まるプロパティをすべて落とし(`pub/utils.js` の `skipPrivate`)、`getObject`/`getActivity`/`findActivityByCollectionAnd*Id` も `includeMeta` が真でなければ `_meta` を削除する。

#### 1. `activitypub-express` (apex) 由来のプロパティ

| プロパティ | 対象 | 型 | 役割・書き込みタイミング |
|---|---|---|---|
| `_meta.collection` | `streams` | `string[]` | アクティビティが所属するコレクション（`inbox`, `outbox`, `followers`, `following`, `liked`, `blocked`, `rejected`, `rejections`, `shares`, `likes` 等）の IRI 配列。受信時 (`net/validators.js`) と送信時 (`net/validators.js` / `pub/activity.js`) に apex が `addMeta` で積み、フォロー承認/いいね/ブースト/ブロック/拒絶等の副作用処理では `updateActivityMeta` が追加・削除する。apex の `hasMeta`/`removeMeta` が `Array.isArray` を要求するため、Firestore 上でも配列のまま保存する (→ [ADR-0017](adr/0017-meta-collection-as-array.md))。 |
| `_meta.privateKey` | `objects` | `string` | ローカルアクターの HTTP 署名用 RSA 秘密鍵 (PEM)。アクター作成時 (`createActor`) に生成・保存され、連合配信時の署名およびローカルユーザー判定 (`getUserCount`) に使用される。 |
| `_meta.isPublic` | `objects` / `streams` | `boolean` | apex の `isPublic()` (`pub/utils.js`) が宛先判定のショートカットとして読むだけのフィールドで、**apex 自身もこのプロジェクトも書き込んでいない**(常に `undefined`)。公開判定は実際には `to`/`cc` 等の `as:Public` で行われている。 |

#### 2. Cloud Functions (`denormalizations.ts`) による非正規化プロパティ

Firestore 上で効率的にインデックスクエリを行うため、`onStreamWritten` トリガーによって自動的に非正規化・付与される。

| プロパティ | 対象 | 型 | 役割・用途 |
|---|---|---|---|
| `_meta.index.collections` | `streams` | `{[key: string]: true}` | `_meta.collection` の写し。 |
| `_meta.index.actors` | `streams` | `{[key: string]: true}` | `stream.actor` をスカラー IRI に解決したもの (`toIdArray`)。 |
| `_meta.index.objects` | `streams` | `{[key: string]: true}` | `stream.object` をスカラー IRI に解決したもの (`toIdArray`)。 |

`_meta.index.*` は IRI の集合を「キーの存在」で表す map で、キーはドキュメント ID と同じ
`escapeFirestoreKey` でエスケープする。Firestore は1クエリにつき `array-contains` を1つしか
使えないため、コレクションと actor/object を組み合わせて絞り込むクエリはすべてこの map への
等価条件で書く(等価条件どうしは複合インデックスの定義なしに index merging で処理される)。
IRI はドットを含むので、クエリのフィールドパスは必ず
`new FieldPath('_meta', 'index', field, escapeFirestoreKey(iri))` の配列形式で組む
(→ [ADR-0021](adr/0021-meta-index-as-maps.md)、ヘルパーは `functions/src/meta.ts`)。

このインデックスは **Firestore に絞り込ませるためだけに使う。** 取得済みドキュメントに対する
判定(`removeActivity` の actor 照合、`getFollowers` の Undo 突き合わせなど)は、トリガーの遅延に
依存しないよう生の `actor`/`object` を `toIdArray` で解決して行う。

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
