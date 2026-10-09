# アーキテクチャ

**現時点の**構成を記述する。設計判断の理由は [`adr/`](adr/) を参照。履歴や進捗はここに書かない。

## 全体構成

Firebase Hosting + Cloud Functions (Gen2, Node 22) + Firestore。TypeScript / ESM。
実装は `functions/` 以下にある。`public/` は個人サイト hakatashi.com の git submodule であり、
本プロジェクトのコードではない(→ [ADR-0008](adr/0008-two-domain-split.md))。

Firestore へのクライアントからの読み書きは `firestore.rules` で全面禁止されており、
すべて Cloud Functions (Admin SDK) 経由でアクセスする。

## レイヤ構成とモジュール依存の向き

モジュール間の依存は、上位から下位への一方向(`entrypoints` → `mastodon/` → `social/` → `store/` / `apex.ts`)に限定されている(→ [ADR-0080](adr/0080-social-domain-layer-and-dependency-direction.md))。

- **エントリポイント層 (`activitypub.ts` / `mastodon/index.ts` / `denormalizations.ts` / `tasks.ts`)**: 各 Cloud Function のハンドラを構築・エクスポートする。`activitypub.ts` は apex インスタンスを再エクスポートせず、各モジュールは `functions/src/apex.ts` から直接 apex を import する。
- **Mastodon API ルート層 (`functions/src/mastodon/`)**: HTTP ルーティング、パラメータ検証、認証、および AP オブジェクトから Mastodon エンティティへの変換 (presenter) を担う。
- **ソーシャル・タイムライン層 (`functions/src/social/`)**: フォロー関係・タイムライン・スレッド探索などのドメインロジックと Firestore クエリを担う。`mastodon/` や `express` には依存しない。
- **ActivityPub / ストレージ層 (`functions/src/apex/`, `functions/src/store/`)**: プロトコル処理および Firestore への低レベル読み書きを行う。

この依存方向(特に `social/` や `denormalizations.ts` から `mastodon/` への依存禁止)は、oxlint の `no-restricted-imports` により静的に強制される。

## デプロイされる Function

`functions/src/index.ts` が以下をエクスポートする。

| Function | 種別 | 役割 |
|---|---|---|
| `activitypub` | HTTP | ActivityPub 本体。`hakatashi.com` にマップ |
| `mastodonApi` | HTTP | Mastodon 互換 REST API + OAuth2。`mastodon.hakatashi.com` にマップ (256MiB メモリ、→ [ADR-0093](adr/0093-split-media-upload-function.md)) |
| `mediaUploadApi` | HTTP | メディアアップロード・取得・編集 API。Hosting rewrite でマップ (2GiB メモリ、→ [ADR-0093](adr/0093-split-media-upload-function.md)) |
| `beforeUserCreate` | Auth blocking | Google ログインかつ特定アドレスのみ許可し、`userInfos` を作成 |
| `onStreamWritten` | Firestore trigger | `streams/{id}` の `_meta.index`(検索用インデックス)を非正規化 |
| `onStreamCreated` | Firestore trigger | `userInfos` の投稿数と、Note の Like / Announce 数を非正規化 |
| `deliveryTask` | Cloud Tasks (`onTaskDispatched`) | 配送ワーカー。受信者1件への配送を1回実行する |
| `pingTask` | Cloud Tasks (`onTaskDispatched`) | Cloud Tasks の疎通確認用。`GET /activitypub/pingTaskQueue` から発行する |
| `cleanupMediaTask` | Scheduled (`onSchedule`) | 未添付のまま24時間経過したメディアを Storage と Firestore から削除する (→ [ADR-0092](adr/0092-post-status-with-media-and-attachment-lifecycle.md)) |

## ActivityPub 層

プロトコル実装は `activitypub-express`(apex)に委譲している。apex は npm 依存ではなく
**このリポジトリにフォークを取り込んでいる**(`functions/src/apex/`。
→ [ADR-0040](adr/0040-fork-activitypub-express.md)、[ADR-0041](adr/0041-vendor-fork-in-tree.md))。
apex が HTTP 署名の検証・生成、JSON-LD 処理、webfinger/nodeinfo、コレクションページングを提供する。
フォークと本体コードの責務境界は [ADR-0042](adr/0042-apex-fork-responsibility-boundary.md) が定める
(フォークから `firebase-admin` / `firebase-functions` / 本体モジュールを import しない)。
フォークは ESM の TypeScript で、型は実装から導出される。`Apex` 型は Store の型で総称化されており、
本体は `apex.store` を自前の `Store` 型として扱う。`_meta` の本体固有キーは `functions/src/meta.ts` が
module augmentation で足す(→ [ADR-0051](adr/0051-typescript-apex-fork.md))。
上流同梱の jasmine spec は `functions/test/apex-upstream/` に置き、Vitest 互換シム経由で
Firestore Store(エミュレータ)に対する適合テストとして `npm test` で実行している。
意図的な設計差で落ちるものは理由を明記して skip している(→ [ADR-0052](adr/0052-connect-apex-specs-to-firestore-store.md))。
フォーク自体の単体テストは `functions/test/unit/apex/` にある。

apex インスタンスの生成は `functions/src/apex.ts` にある(`functions/src/tasks.ts` からも
import されるため、`functions/src/activitypub.ts` との import サイクルを避けて分離している)。
`functions/src/activitypub.ts` はそれを使って express のルーティングを行う。特筆すべき点:

- Cloud Functions は body を先に読んでしまうため、JSON-LD の body を手動でパースしている。
- HTTP 署名検証を通すため `req.headers.host` を公開ドメインで上書きしている。
- **HTTP 署名の検証・生成は apex フォーク内の自前実装**(`functions/src/apex/net/security.ts`)が行う
  (→ [ADR-0044](adr/0044-self-implemented-http-signature-in-apex-fork.md))。draft-cavage 以外の形式や
  不正な署名は 403、鍵取得の一時的失敗は 5xx に分類する。署名対象に `date` か `(created)`、
  POST では `digest` を必須とし、`Digest` を未加工ボディ(Cloud Functions が提供する `req.rawBody`)の
  SHA-256 と照合し、署名時刻が許容幅(未来 1 時間・過去 13 時間)を外れたものを 403 で拒否する
  (→ [ADR-0056](adr/0056-verify-digest-and-date-window-in-http-signature.md))。
- apex はレスポンス送出後に `postWork` を実行する設計だが、Cloud Functions では
  レスポンス後の CPU が保証されない。そのため `functions/src/postWork.ts` の
  `runPostWorkBeforeSend` ミドルウェアがリクエストごとに `res.send` を差し替え、
  送出**前**に `postWork` と `apex-inbox`/`apex-outbox` イベントを await している
  (→ [ADR-0013](adr/0013-scoped-postwork-middleware.md))。所要時間は
  `postWorkCompleted` ログに出る。`apex-inbox` リスナーで Follow の自動 Accept を実装している。
- inbox への配送処理は `apex.net.inbox.post` をそのまま利用している。
  重複配送の検出と `isNewActivity` の設定は `Store#saveActivity` の戻り値契約に基づいて apex 内部で完結して行われ(→ [ADR-0049](adr/0049-save-activity-return-contract-and-inbox-dedup.md))、
  スレッド解決(`resolveThread`)を経て自分の投稿への外部リプライがフォロワーへ転送される(Inbox Forwarding, W3C AP 7.1.2)。
  (なお、Like/Announce の通常オブジェクト解決は apex フォークの validators で行われ [ADR-0047](adr/0047-resolve-like-announce-object-in-apex.md)、
  Undo の object 非正規化は apex フォークの `activity.save` で行われ [ADR-0048](adr/0048-denormalize-undo-object-in-apex.md)、
  宛先の `as:Public` 正規化は apex フォークの JSON-LD 処理層で行われ [ADR-0045](adr/0045-normalize-public-address-in-apex-jsonld.md)、
  Update/Delete の同一オリジン検証は apex フォークの `validateOwner` で行われる → [ADR-0046](adr/0046-validate-owner-same-origin-in-apex.md))。
- 承認した `Follow` には `_meta.isPublic` を付与し、匿名の `/followers` コレクションに
  表示されるようにしている(Follow は `to`/`cc` を持たないため → ADR-0035)。
- `Like` / `Announce` の受信カウントは apex 本体のコレクション機構(activity 専用)を使わず、
  `onStreamCreated` トリガーで対象オブジェクトの `_meta.likesCount` / `sharesCount` を
  直接インクリメント/デクリメントする(→ ADR-0037, ADR-0039)。
- **リモートオブジェクトの取得は apex フォークの `requestObject` が SSRF セーフに行う**
  (`functions/src/apex/pub/federation.ts` / `ssrf.ts`。→ [ADR-0050](adr/0050-ssrf-safe-request-object-in-apex.md))。
  スキームは既定で `https` のみ、アドレスは `unicast` のみ。`apex.ts` が
  `remoteFetchPolicy` を注入し、ローカル開発/テスト時のみ `http` とループバックを許可する。
  リダイレクトを含む**各ホップ**で名前解決した IP が unicast であることを検証する。
  DNS rebinding を防ぐため、検証済みの IP に固定した undici の `Agent` で接続する。
  レスポンスサイズ(5MB)・リダイレクト回数(5回)・タイムアウトにも上限を設ける。
  外部 `@context` の取得(`jsonldContextLoader`)と配送(`apex.deliver`)も同じ検証と IP 固定を通る。
  `@context` の取得失敗・JSON-LD 展開エラーは 400 で拒否し、送信側の再送を止める
  (→ [ADR-0054](adr/0054-ssrf-safe-jsonld-context-loader.md))。配送のレスポンス本文は読まずに破棄する。
- 受信時の参照解決(`resolveReferences`)は訪問済み IRI で循環を検出し、解決総数(既定 10 件)・
  並行度(既定 2)・再帰深さ(既定 5)に上限を設ける。`Hashtag` は解決しない
  (→ [ADR-0055](adr/0055-resolve-references-limits-and-cycle-detection.md))。
- 受信アクティビティに埋め込まれたオブジェクトがローカル IRI または既存オブジェクトの場合、
  apex はキャッシュとして再保存せず既存のものを使う。`Store#saveObject` も既存ドキュメントの
  `_meta` を引き継ぎ、秘密鍵や非正規化カウンタが外部入力で上書きされない
  (→ [ADR-0053](adr/0053-prevent-object-corruption-and-counter-underflow.md))。
- ActivityPub C2S のプロキシエンドポイント(`/activitypub/proxy`、actor の `endpoints.proxyUrl`)は公開しない。
- 管理者専用エンドポイント(`/activitypub/createAdmin`, `/createPost`,
  `/publishProfileUpdate`, `/pingTaskQueue`, `/deliveries/failed`, `/deliveries/resend`)は
  `X-Hakatashi-Token` ヘッダで認証する。
- `offlineMode: true` で初期化しており、apex 内蔵の配送ループ(`setInterval` による
  常駐処理)は起動しない。配送は `Store#deliveryEnqueue`(`functions/src/store/index.ts`)が
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

apex の `IApexStore` インターフェースを Firestore で実装した `Store` クラス(`functions/src/store/index.ts`)が中核。
`Store` クラスには apex の契約だけを置き、apex が呼ばないアプリ独自のクエリや操作は
`functions/src/store/` の機能別のファイルにモジュール関数として置く(→ [ADR-0085](adr/0085-split-store-by-responsibility.md))。

| ファイル | 内容 |
|---|---|
| `index.ts` | `Store` クラス(apex の契約)。apex は `apex.store` 越しにこれを呼ぶ |
| `updates.ts` | `Store` の更新系メソッドが共有する内部処理(`_meta` の引き継ぎ、`streams` の埋め込みコピーの差し替え) |
| `objects.ts` | `objects` を IRI の一覧でまとめて引く `getObjects` |
| `notes.ts` | タイムライン用の `getNotes`、スレッド用の `getReplies` |
| `activities.ts` | `streams` に対する apex の契約外の操作(`markActivityPublic`、タイムライン用の `getAnnounces`) |
| `deliveries.ts` | Cloud Tasks への配送タスクの発行と、配送結果の記録・取得(→ [ADR-0012](adr/0012-delivery-results-in-firestore.md)) |
| `limits.ts` | `FIRESTORE_IN_QUERY_LIMIT` などの Firestore の制約に関する定数 |

新しいクエリを足すときは、apex の契約なら `index.ts` に、アプリ独自なら機能別のファイルに置く。

Firestore のドキュメント ID に URL をそのまま使えないため、
`escapeFirestoreKey` / `unescapeFirestoreKey`(`functions/src/firebase.ts`)で
`%`, `/`, `.` をエスケープしている。エスケープ済みキーはブランド型 `FirestoreKey` で
区別され、生文字列の取り違えを型レベルで防止する(→ [ADR-0027](adr/0027-branded-firestore-key.md))。

| コレクション | ドキュメント ID | 内容 |
|---|---|---|
| `objects` | エスケープした IRI | actor / Note などの AP オブジェクト。`_meta.privateKey` に秘密鍵 |
| `streams` | エスケープした IRI | アクティビティ。`_meta.collection` が所属コレクションの IRI |
| `contexts` | エスケープした URL | JSON-LD コンテキストのキャッシュ |
| `deliveries` | エスケープした `アクティビティ ID + 宛先` | 配送結果(→ [ADR-0012](adr/0012-delivery-results-in-firestore.md)) |
| `userInfos` | エスケープした actor IRI | Mastodon 用のユーザーメタ情報(`functions/src/schema.ts`) |
| `userInfos/{actor}/bookmarks`, `pins` | エスケープした Note IRI | ブックマーク・ピン留め(→ [ADR-0070](adr/0070-status-viewer-attributes-and-storage.md)) |
| `userInfos/{actor}/followers`, `following` | エスケープした相手の actor IRI | フォロー関係の射影。Follow を書き換える Store の処理と同じトランザクションで差分更新する(→ [ADR-0082](adr/0082-project-follow-relations-in-store.md)) |
| `userInfos/{actor}/favourites`, `reblogs` | エスケープした Note IRI | お気に入り・ブーストの射影。ローカル actor の Like / Announce を書き換える Store の処理と同じトランザクションで差分更新する(→ [ADR-0084](adr/0084-project-favourites-and-reblogs.md)) |
| `userInfos/{actor}/notifications` | エスケープしたアクティビティ IRI | 通知の射影。受信したアクティビティ(Create / Like / Announce / Follow)を書き換える Store の処理と同じトランザクションで差分更新する(→ [ADR-0088](adr/0088-project-notifications-in-store.md)) |
| `markers` | `エスケープした actor IRI_タイムライン名` | `/api/v1/markers` の既読位置(→ [ADR-0067](adr/0067-stubs-markers-and-instance-info.md)) |
| `mediaAttachments` | Mastodon ID(20 桁の数字) | アップロードされたメディアのメタデータ(→ [ADR-0091](adr/0091-media-upload-and-storage.md)) |
| `mastodonIds` | Mastodon ID(20 桁の数字) | ID → AP IRI のマッピング(→ [ADR-0058](adr/0058-mastodon-id-snowflake-layout.md)) |
| `mastodonIdsByIri` | エスケープした IRI | AP IRI → Mastodon ID のマッピング |
| `idempotencyKeys` | `sha256(actor IRI + キー)` | `POST /api/v1/statuses` の `Idempotency-Key` → Note IRI。`expiresAt` に TTL ポリシー(→ [ADR-0063](adr/0063-post-status-and-idempotency-key.md)) |
| `clients` / `accessTokens` / `refreshTokens` / `authorizationCodes` / `users` | 自動 ID | OAuth2 用 |

### Cloud Storage

アップロードされたメディア画像 (`POST /api/v2/media` 等) は Firebase 既定バケット (`${projectId}.firebasestorage.app`) に保存される (→ [ADR-0091](adr/0091-media-upload-and-storage.md))。
`storage.rules` でクライアントからの直接の読み書きを全面禁止 (`allow read, write: if false;`) しており、書き込みは Cloud Functions (Admin SDK) 経由でのみ行われる。
保存された画像オブジェクトは公開読み取り (`makePublic()`) に設定され、`https://storage.googleapis.com/${bucket}/${path}` から直接配信される。ブラウザクライアント (Elk / Phanpy 等) からクロスオリジンで読み込めるよう、バケットには `storage.cors.json` で CORS 設定 (`Access-Control-Allow-Origin: *`) が適用されている。
投稿 (`POST /api/v1/statuses`) 時に `media_ids` として添付され、Note の `attachment` に組み込まれると `statusIri` が更新される。
添付されないまま24時間以上経過したメディアは、日次スケジュール Function (`cleanupMediaTask`, `onSchedule`) により Cloud Storage のファイルと Firestore のメタデータの双方が自動削除される (→ [ADR-0092](adr/0092-post-status-with-media-and-attachment-lifecycle.md))。
アバター・ヘッダー画像 (`PATCH /api/v1/accounts/update_credentials` 等) も同様に Cloud Storage の `accounts/avatars/${id}.${ext}` および `accounts/headers/${id}.${ext}` に保存され、公開 URL が Actor オブジェクト (`icon`, `image`) に設定される。古い画像は変更時または削除 API (`DELETE /api/v1/profile/avatar`, `/header`) 実行時に Storage から即座に削除される (→ [ADR-0094](adr/0094-avatar-header-update-and-credentials.md))。

apex は `_meta.collection` を「アクティビティが所属するコレクションの集合」として扱い、
Firestore 上でもそのまま配列として保存する。コレクション単体での所属判定
(`getStream`/`getStreamCount`)は `array-contains` クエリで行い
(→ [ADR-0017](adr/0017-meta-collection-as-array.md))、他の条件と組み合わせる検索は
後述の `_meta.index` を使う(→ [ADR-0021](adr/0021-meta-index-as-maps.md))。

### `_meta` メタデータフィールド

`objects` および `streams` コレクション内のドキュメントには、内部管理用のメタデータとして `_meta` オブジェクトが付与される。apex は JSON-LD 出力時に `_` で始まるプロパティをすべて落とし(`pub/utils.ts` の `skipPrivate`)、`getObject`/`getActivity`/`findActivityByCollectionAnd*Id` も `includeMeta` が真でなければ `_meta` を削除する。

#### 1. `activitypub-express` (apex) 由来のプロパティ

| プロパティ | 対象 | 型 | 役割・書き込みタイミング |
|---|---|---|---|
| `_meta.collection` | `streams` | `string[]` | アクティビティが所属するコレクション（`inbox`, `outbox`, `followers`, `following`, `liked`, `blocked`, `rejected`, `rejections`, `shares`, `likes` 等）の IRI 配列。受信時 (`net/validators.ts`) と送信時 (`net/validators.ts` / `pub/activity.ts`) に apex が `addMeta` で積み、フォロー承認/いいね/ブースト/ブロック/拒絶等の副作用処理では `updateActivityMeta` が追加・削除する。apex の `hasMeta`/`removeMeta` が `Array.isArray` を要求するため、Firestore 上でも配列のまま保存する (→ [ADR-0017](adr/0017-meta-collection-as-array.md))。 |
| `_meta.privateKey` | `objects` | `string` | ローカルアクターの HTTP 署名用 RSA 秘密鍵 (PEM)。アクター作成時 (`createActor`) に生成・保存され、連合配信時の署名およびローカルユーザー判定 (`getUserCount`) に使用される。 |
| `_meta.isPublic` | `streams` | `boolean` | apex の `isPublic()` (`pub/utils.ts`) が `to`/`cc` の `as:Public` と並んで読む宛先判定のショートカット。`Follow` は `to`/`cc` を持たないため、承認時に `Store#markActivityPublic` (`activitypub.ts` の Follow 自動承認処理) が明示的に `true` を書き込み、匿名の `/followers` コレクションに表示されるようにする (→ [ADR-0035](adr/0035-mark-accepted-follow-as-public.md))。 |
| `_meta.likesCount` / `_meta.sharesCount` | `objects` | `number` | `Like` / `Announce` の受信カウント。apex 本体の likes/shares コレクション機構は activity (streams) 専用で Note のような object を対象にすると機能しないため使わず、`onStreamCreated` トリガーが対象オブジェクトへ直接インクリメント/デクリメントする (→ [ADR-0037](adr/0037-denormalize-like-announce-counts.md))。 |
| `_meta.published` | `objects` | `string` | タイムラインの並べ替え・範囲指定用の `published`。ミリ秒つき ISO 8601 (UTC) で、Mastodon ID のタイムスタンプと同じ規則で決める(未来は現在時刻に丸める)。AP の `published` は apex の `fromJSONLD` が配列に展開する (`compactArrays: false`) ため Firestore のクエリには使えず、`Store#saveObject` / `updateObject` が非正規化して書く。既存データの再計算は `functions/bin/backfillPublishedMeta.ts` (→ [ADR-0062](adr/0062-cursor-pagination-by-mastodon-id.md))。 |
| `_meta.attributedTo` / `_meta.inReplyTo` / `_meta.preferredUsername` | `objects` | `string` | 検索用に、同名のフィールドの先頭の1件を文字列に正規化した写し(IRI は `toIdArray`、`preferredUsername` は `toStringValue`)。受信したオブジェクトは apex が配列で、ローカルのものはスカラーで保存するため、`getNotes` / `getReplies` / acct lookup はこちらを等価条件で引く。解決できなければキーを持たない。`Store#saveObject` / `updateObject` が保存する内容から計算し直して書く。既存データは `functions/bin/backfillObjectQueryMeta.ts` (→ [ADR-0086](adr/0086-normalize-object-query-fields-into-meta.md))。 |
| `_meta.actor` / `_meta.published` | `streams` (Announce) | `string` | タイムライン検索用に、Announce アクティビティの actor と published を文字列に正規化した写し。`Store#saveActivity` で保存時に非正規化して書く。既存データは `functions/bin/backfillActivityQueryMeta.ts` (→ [ADR-0096](adr/0096-boosts-in-timelines-and-account-statuses.md))。 |

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
判定(`removeActivity` の actor 照合など)は、トリガーの遅延に
依存しないよう生の `actor`/`object` を `toIdArray` で解決して行う。

apex のストア抽象では集計ができないため、投稿数は Firestore Trigger
(`functions/src/denormalizations.ts`)で `userInfos` に差分更新で非正規化している。
既存データの再計算には `functions/bin/denormalizations.ts` を使う。

フォロー関係は `userInfos/{actor}/followers`・`following` に射影している
(`functions/src/projections/follows.ts`)。Store の `saveActivity` / `updateActivityMeta` / `removeActivity` が
Follow を書き換えるとき、同じトランザクションで射影と `followers_count` / `following_count` を差分更新する
(→ [ADR-0082](adr/0082-project-follow-relations-in-store.md))。判定は Follow の `_meta.collection`
(apex の followers / following / rejections への所属)による。Mastodon API のフォロー関係の読み取りは
すべてこの射影から行い、streams の Follow / Accept / Undo は引かない
(→ [ADR-0083](adr/0083-read-follow-relations-from-projection.md))。
射影はローカル actor の分しかない。既存データからの組み立て直し(カウンタを含む)には
`functions/bin/backfillFollowProjection.ts` を使う。

お気に入り・ブーストも同じ形で `userInfos/{actor}/favourites`・`reblogs` に射影している
(`functions/src/projections/reactions.ts`)。ローカル actor 発の Like / Announce が streams に存在する間だけ、
対象 Note のドキュメントにそのアクティビティの IRI が載る。Undo の送信と同時に元のアクティビティを
`Store#removeActivity` で消すので、Undo とは突き合わせない(→ [ADR-0084](adr/0084-project-favourites-and-reblogs.md))。
Store が呼ぶ射影は `functions/src/projections/index.ts` でまとめている。
既存データからの組み立て直しには `functions/bin/backfillReactionProjection.ts` を使う。

通知も同じ形で `userInfos/{actor}/notifications` に射影している
(`functions/src/projections/notifications.ts`)。受信した Create(Note へのメンション)・Like・Announce・
Follow を書き換える Store の処理と同じトランザクションで差分更新する(→ [ADR-0088](adr/0088-project-notifications-in-store.md))。
取り消し(Undo)による `Store#removeActivity` で元のアクティビティが消えたとき、同じトランザクションで通知も消す。
既存データからの組み立て直しには `functions/bin/backfillNotificationProjection.ts` を使う。

## ソーシャル・タイムライン層 (social/)

`functions/src/social/` 以下。Mastodon API 表現や HTTP ルーティングから独立した、純粋なソーシャルグラフ探索・タイムライン収集・スレッド走査のドメイン層(→ [ADR-0080](adr/0080-social-domain-layer-and-dependency-direction.md))。

| ファイル | 役割 |
|---|---|
| `follows.ts` | 射影からのフォロー関係の読み取り(フォロー中・承認待ち・フォロワー、相手ごとの関係 `getFollowFlags`、相手への代表の Follow `getFollowIri`、一覧のページング)、および古い重複 Follow の削除(`removeSupersededFollows`) |
| `timelines.ts` | Note・Announce コレクションのカーソル走査(`collectVisibleNotes` / `collectTimelineItems`)、アカウント投稿・公開・ホームタイムラインの収集(重複ブースト排除・可視性判定を含む) |
| `threads.ts` | Note のスレッド祖先・子孫探索(`getThreadAncestors`, `getThreadDescendants`) |
| `visibility.ts` | Note の可視性判定(`isNoteVisibleTo`, `isNotePublicTimelineEligible`, `noteToVisibility`) |
| `types.ts` | `NoteObject` などのドメイン型定義 |

フォロー関係は射影(→ [ADR-0083](adr/0083-read-follow-relations-from-projection.md))から読み、この層は Mastodon API ルーターモジュールを読み込まない。

## Mastodon API 層

`functions/src/mastodon/` 以下。自前 UI は作らず、Elk などのサードパーティクライアントを
フロントエンドとして使う(→ [ADR-0004](adr/0004-no-custom-ui-use-elk.md))。

| ファイル | 役割 |
|---|---|
| `index.ts` | express アプリ、`beforeUserCreate` |
| `api.ts` | `/api/**` のルーター。CORS、`routes/` の各ルーターの登録、404 フォールバックとエラーハンドラ |
| `routes/*.ts` | リソースごとのルート定義とリクエストの zod スキーマ(`instance` / `stubs` / `markers` / `accounts` / `timelines` / `statuses` / `statusActions` / `apps`) |
| `presenters/account.ts` | AP actor → Account / CredentialAccount / Relationship の変換と、アカウント ID の解決 |
| `presenters/status.ts` | Note / Announce → Status の変換、閲覧者のインタラクション状態の解決、タイムライン・スレッドの Status 化 |
| `http/auth.ts` | OAuth トークンの検証(`authRequired` / `scopeRequired` / `getOptionalViewer`)と有効なスコープの一覧 |
| `http/params.ts` | フォーム由来の真偽値などパラメータの解釈 |
| `http/responses.ts` | `Link` ヘッダの付与や 422 応答などの共通レスポンス |
| `statusAttributes.ts` | Note から Status の属性(visibility・language・各種カウント・mentions・tags・media_attachments など)を導出する純粋関数(→ [ADR-0060](adr/0060-derive-status-attributes-from-note.md)、[ADR-0090](adr/0090-derive-media-attachments-from-note.md)、[ADR-0092](adr/0092-post-status-with-media-and-attachment-lifecycle.md)) |
| `statusContent.ts` | 投稿本文のメンション・URL・ハッシュタグを解析して HTML と `tag` を組み立てる(→ [ADR-0071](adr/0071-post-content-formatting-and-mentions.md)) |
| `pagination.ts` | `max_id` / `since_id` / `min_id` / `limit` の解釈と `Link` ヘッダの生成(Firestore には触らない) |
| `oauth.ts` | OAuth2 のエンドポイント。認可画面に FirebaseUI を埋め込む |
| `oauth2Model.ts` | `@node-oauth/oauth2-server` の Firestore バックエンド |
| `instanceInformation.ts` | `/api/v1/instance` と `/api/v2/instance` のレスポンス |

API で露出する Status などの ID は AP IRI とは別に採番した、時系列順の固定長(20 桁)数値文字列である
(レイアウトは Mastodon と同じ `ミリ秒 << 16 | シーケンス`。→ [ADR-0006](adr/0006-mastodon-api-id-scheme.md)、
[ADR-0058](adr/0058-mastodon-id-snowflake-layout.md))。`functions/src/mastodonId.ts` が採番と相互変換を担い、
`Store#saveObject` / `Store#saveActivity` が保存と同じトランザクションで `published` を基準に採番する。
読み出し時(`getMastodonIds`)に未採番の IRI があればその場で採番する。
既存データのバックフィルは `functions/bin/assignMastodonIds.ts`。

コレクション系エンドポイント(`timelines/public`・`timelines/home`・`accounts/:id/statuses`・`accounts/:id/followers`・`accounts/:id/following`)は
`max_id` / `since_id` / `min_id` / `limit` でページングし、`Link` ヘッダ(`next` / `prev`)で次のページを示す
(`Access-Control-Expose-Headers: Link` を付ける)。カーソルは Mastodon ID で、応答は常に新しい順。
Firestore へは `_meta.published` の範囲と順序で問い合わせ(`type + [_meta.attributedTo +] _meta.published` の昇順・降順、および Announce 用の `type + _meta.actor + _meta.published` 複合インデックス)、
可視性の判定と ID の厳密な比較は取得後にアプリケーション側で行う。ホームタイムラインとアカウント投稿一覧では Note と Announce をそれぞれ独立カーソルで取得して Mastodon ID 順にマージし、同一 Note IRI の重複ブーストは最新優先で排除する(→ [ADR-0096](adr/0096-boosts-in-timelines-and-account-statuses.md))。followers / following のカーソルは Follow アクティビティの Mastodon ID
(→ [ADR-0062](adr/0062-cursor-pagination-by-mastodon-id.md))。

投稿(`POST /api/v1/statuses`)と管理者用の `/activitypub/createPost` は、どちらも `functions/src/notes.ts` の
`publishNote` で Note を保存し、`Create` を `apex.addToOutbox` に渡して配送する。宛先は visibility から
Mastodon と同じ規則で決め、リプライ先の投稿者を宛先に加える。`Idempotency-Key` は Note を作る前に
`idempotencyKeys` へ予約し、1時間以内の再送には既存の Status を返す
(→ [ADR-0063](adr/0063-post-status-and-idempotency-key.md))。

個別投稿の取得(`GET /api/v1/statuses/:id`)・削除(`DELETE /api/v1/statuses/:id`)・スレッド表示(`GET /api/v1/statuses/:id/context`)は
Mastodon ID から Note または Announce を引いて処理する。Note 削除時は Tombstone 化して `Delete` を outbox に積み、
`onStreamCreated` で `statuses_count` を減算する。自分のブースト (Announce) の ID が渡された場合はブーストを取り消す (unreblog、→ [ADR-0096](adr/0096-boosts-in-timelines-and-account-statuses.md))。context は手元に存在する Note のみ `inReplyTo` を祖先方向(最大40件)・
子返信方向(DFS、深さ20・件数60上限、`type + _meta.inReplyTo + _meta.published` 複合インデックス)に探索し、
循環参照を防ぎつつ可視性フィルタを通す(→ [ADR-0064](adr/0064-get-delete-statuses-and-context.md))。

アカウント系エンドポイント(`GET /api/v1/accounts/verify_credentials`・`PATCH /api/v1/accounts/update_credentials`・`GET /api/v1/accounts/:id`・`GET /api/v1/accounts/relationships`・`POST /api/v1/accounts/:id/follow`・`POST /api/v1/accounts/:id/unfollow`)は、
自アカウント情報(Elk 互換の `role` / `source` を含む)の取得・更新(AP `Update` 配送付き)や、フォロー・アンフォロー(AP `Follow` / `Undo(Follow)` 配送付き)、
および関係性の判定を提供する(→ [ADR-0065](adr/0065-account-endpoints-and-follow-unfollow.md))。
unfollow で Undo する Follow は apex の following / outbox コレクションから探し、どちらにもなければ
フォロー関係の射影の代表の Follow(`followIri`)を使う。

ローカルアカウントの Account ID は `userInfos` の `id`、リモートアカウントは Mastodon ID で採番した値を使い、
Status の `mentions[].id` もこれに揃える(→ [ADR-0069](adr/0069-mastodon-account-id-and-status-mentions.md))。
Status の `favourited` / `reblogged` / `bookmarked` / `pinned` は認証ユーザーの
`userInfos/{actor}/favourites`・`reblogs`・`bookmarks`・`pins` から判定する
(→ [ADR-0070](adr/0070-status-viewer-attributes-and-storage.md)、[ADR-0084](adr/0084-project-favourites-and-reblogs.md))。
unfavourite / unreblog は射影に載っている Like / Announce をすべて Undo する。
認証・スコープのエラーは Mastodon と同じく 401 / 403 を JSON で返す(→ [ADR-0074](adr/0074-mastodon-api-authentication-error-handling.md))。

実装状況は [`mastodon-api-coverage.md`](mastodon-api-coverage.md) を参照。
未定義のルートは 404 にフォールバックする(→ [ADR-0067](adr/0067-stubs-markers-and-instance-info.md))。

## デプロイ

`.firebaserc` で本番 `activitypub-firebase` と開発 `activitypub-firebase-dev` の2環境を定義。
`functions/src/firebase.ts` が `projectId` を見てドメインを切り替える。

`.github/workflows/main.yml` が main への push でテスト・lint 実行後、
**両方の環境に同時にデプロイ**する。

## 依存関係

`firebase-functions` / `firebase-admin` / `@node-oauth/oauth2-server` / `express` /
`jsonld` / `undici` が主要な依存。バージョンは `functions/package.json` を参照。
`activitypub-express` は npm 依存ではなく `functions/src/apex/` にフォークを取り込んでいる
(→ [ADR-0041](adr/0041-vendor-fork-in-tree.md))。
型定義のみ `masto` パッケージを利用している(`CamelToSnake` 型ユーティリティで
camelCase の型定義を snake_case の JSON に変換している)。
