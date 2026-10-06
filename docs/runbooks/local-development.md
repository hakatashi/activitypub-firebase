# ローカル開発

## 前提

- Node.js(バージョンは `functions/package.json` の `engines` を参照)
- Firebase CLI(`functions/package.json` の devDependencies に `firebase-tools` として入る)
- リポジトリのクローン時は `--recurse-submodules` を付けるか、
  `git submodule update --init --recursive` を実行する

依存のインストールは `functions/` 配下で行う。

```bash
npm --prefix functions ci
```

## ビルドと lint

```bash
npm --prefix functions run build         # tsc
npm --prefix functions run build:watch
npm --prefix functions run lint          # oxlint
npm --prefix functions run format        # oxfmt --write
npm --prefix functions run format:check  # oxfmt --check
```

lint/format の構成は [ADR-0018](../adr/0018-eslint-to-oxlint-oxfmt.md) を参照。

`tsconfig.json` は型チェック用(`noEmit`、`src` / `test` / `bin` が対象)、`tsconfig.build.json` は出力用(`src` のみ)。
`build` は後者、`typecheck` は前者を使う。Vitest は型を検査しないため、テストの型エラーは `typecheck` でのみ検出される。
PR の CI では `build` と `typecheck` が走る([ADR-0079](../adr/0079-typecheck-tests-and-bin.md))。

## テスト

Firestore エミュレータを起動した上で Vitest を実行する。npm script が両方をまとめている。
テストランナーの選定理由は [ADR-0011](../adr/0011-vitest-over-jest.md) を参照。

### テストの実行方法と使い分け

用途に応じて以下のコマンドを使い分ける。**PR を作成する前には全件実行 (`npm test`) が必須 (AGENTS.md の規則)。**

| コマンド | 対象 | 使い分けの目安 |
|---|---|---|
| `npm --prefix functions test` | 全テスト (880件超) | PR 作成前の最終確認、全体のリグレッション確認 |
| `npm --prefix functions run test:changed` | 未コミット変更の影響を受けるテスト | 日常の開発イテレーション (最も高速) |
| `npm --prefix functions run test:changed:main` | `origin/main` からの差分の影響を受けるテスト | ブランチでコミットを進めている最中の確認 |
| `npm --prefix functions run test:only -- <filter>` | 指定したファイル・テスト名・パス | 特定のテストの集中デバッグ、部分実行 |
| `npm --prefix functions run test:watch` | Vitest ウォッチモード | TDD などテスト駆動での継続実行 |

#### 1. 全件実行

```bash
npm --prefix functions test
```

エミュレータを起動し、すべての unit、integration、apex-upstream spec を並列実行する。
PR を作成する前には必ずこのコマンドを実行し、全件パスすることを確認する。

#### 2. 変更に関係するテストのみ実行 (`test:changed`)

```bash
npm --prefix functions run test:changed        # 作業ツリーの未コミットの変更 (HEAD との差分)
npm --prefix functions run test:changed:main   # origin/main との差分
```

Vitest の `--changed` オプションを利用し、git の差分から変更されたファイルおよびそれらを import しているテストファイルを自動検出して実行する。テストの多くをスキップできるため、数秒で結果が得られ開発のイテレーションが大幅に高速化する。

> [!NOTE]
> **`test:changed` と `vitest related` の違い**
> - `--changed`: git の diff (HEAD または指定コミットとの差分) から変更ファイルを Vitest が自動取得し、関連テストを実行する。
> - `vitest related <files>`: git の状態にかかわらず、引数で渡されたファイル群 (例: `src/store/index.ts`) を静的解析して依存するテストを実行する。特定ファイルを明示して関連テストを網羅したい場合は後述の `test:only -- related <files>` を使う。

#### 3. 部分実行と絞り込み (`test:only`)

`firebase emulators:exec` に直接引数を追加するとエミュレータ CLI の引数エラーになるため、Vitest への引数転送には `test:only` を使う。

```bash
# 特定のテストファイルを実行
npm --prefix functions run test:only -- test/unit/store.spec.ts

# テスト名で絞り込み (-t / --testNamePattern)
npm --prefix functions run test:only -- -t "round-trips an object"

# ディレクトリ単位で実行 (unit と integration のみ実行)
npm --prefix functions run test:only -- test/unit test/integration

# apex-upstream spec を除外して実行
npm --prefix functions run test:only -- --exclude 'test/apex-upstream/**'

# 指定ファイルに関連するテストを実行 (vitest related)
npm --prefix functions run test:only -- related src/store/index.ts
```

#### 4. エミュレータ起動中の直接実行

開発中に `npm --prefix functions run serve` や `firebase emulators:start --only firestore` などで既に Firestore エミュレータが起動している場合は、エミュレータの再起動コストをかけずに Vitest を直接実行できる。

```bash
cd functions
cross-env GCLOUD_PROJECT=activitypub-firebase-dev npx vitest run [filter]
cross-env GCLOUD_PROJECT=activitypub-firebase-dev npx vitest run --changed
```

### apex-upstream spec の扱い

`test/apex-upstream/` には上流の `activitypub-express` 同梱 spec が配置されており、Firestore Store (`functions/src/store/index.ts`) に対する適合テストとして繋ぎ直されている (→ [ADR-0052](../adr/0052-connect-apex-specs-to-firestore-store.md))。

- **位置づけ**: 約 4,800 行の上流 spec 資産を可能な限り無改変で動かすため、`test/apex-upstream/setup.ts` で Jasmine 互換シム (spy や clock、`done()` コールバック) や Firestore CollectionReference への MongoDB 風ヘルパーメソッド (`findOne`, `insertOne` など) を提供している。
- **全テスト共通の setupFile**: `test/apex-upstream/setup.ts` は `vitest.config.ts` の `setupFiles` に登録されているため、全テストで有効になっている。
- **意図的な skip**: 約 210 件中 69 件のテストが skip されている。これは Cloud Tasks による非同期配送 (ADR-0003, ADR-0052) や SSRF ポリシーなど、このプロジェクトの意図的な設計差に起因するものであり、理由がテストコード内に明記されている。
- **除外してよいケースと含めるべきケース**:
  - **除外してよいケース**: Mastodon API エンドポイント (`test/unit/mastodon*`, `test/integration/mastodon*`)、WebFinger、各種ユーティリティなど、apex 内部や Store の基本契約に影響しない箇所の変更時。これらを除外することでテスト時間を短縮できる (`--exclude 'test/apex-upstream/**'` または `test/unit test/integration`)。
  - **含めるべきケース**: `functions/src/apex/` (apex フォーク本体) や `functions/src/store/` (Store 実装) を変更したときは、上流互換性を壊していないか確認するため必ず含める。
  - **PR 作成前**: 原則として必ず全件実行 (`npm test`) に含める。

### 内部動作と並列化

内部では以下を行っている。

- `firebase emulators:exec --only firestore` でエミュレータを起動(ポートは `firebase.json` で 34567)
- `GCLOUD_PROJECT=activitypub-firebase-dev` を設定する。
  テスト実行時は `test/setup-env.ts` が Vitest ワーカーごとに分離された
  `projectId` (`activitypub-firebase-dev-w${poolId}`) を `GCLOUD_PROJECT` と `FIREBASE_CONFIG`
  に設定し、エミュレータ上でワーカー間のデータ衝突を防ぐ (→ [ADR-0077](../adr/0077-isolate-test-firestore-by-worker-project-id.md))。
  また `activitypub-firebase-dev*` の前方一致により、
  `functions/src/firebase.ts` の分岐は dev ドメイン (`activitypub-dev.hakatashi.com`) を返す
- `vitest.config.ts` の `test.fileParallelism: true` (および `maxWorkers: 4`) でテストファイルを
  ワーカーごとに並列実行する

### ディレクトリ構成

- `test/unit/` — 外部 I/O のない純粋関数、または Firestore エミュレータのみに依存するテスト
  (`store/` の各関数・メソッドなど)。ネットワークや実際の ActivityPub 連合には依存しない。
  - `test/unit/apex/` — apex フォークライブラリ単体のテスト。Firebase / Firestore に依存せず、ライブラリの純粋な機能や通信処理をテストする。
- `test/integration/` — Express アプリ(`activitypub` / `mastodonApi`)に対して
  `supertest` でリクエストを送るテスト。
- `test/apex-upstream/` — 上流 `activitypub-express` の適合テスト群 (Jasmine 互換シム駆動、ADR-0052)。
- `test/helpers/` — テスト共通ヘルパー (`resetFirestore`, `createLocalActor`, `addAccessToken`, `mastodon`)。

Firestore エミュレータを使うテストでは、各テストの `afterEach` でテストヘルパーの
`resetFirestore()` (`test/helpers/index.ts`) を呼び出し、現在のワーカーのプロジェクトの全データを消去する。
エミュレータのリセットエンドポイントを直接叩かず、必ず `resetFirestore()` を使うこと。

`vitest.config.ts` は Vite のネイティブな TypeScript/ESM 変換を使うため、
Jest 時代のような `moduleNameMapper` での `./x.js` → `./x` 解決は不要。

### Cloud Storage のテスト差し替え

Cloud Storage へのアップロード処理は薄い抽象化モジュール (`functions/src/storage/media.ts`) に集約されている (→ [ADR-0091](../adr/0091-media-upload-and-storage.md))。
テスト実行時に Storage エミュレータを起動する必要はなく、テストコード内で `setMediaStorageDriver()` を使ってインメモリストレージに差し替える。テスト終了後は `resetMediaStorageDriver()` で元に戻す。

## エミュレータでの手動確認

```bash
npm --prefix functions run serve   # build してから functions エミュレータを起動
npm --prefix functions run shell   # functions シェル
```

`functions/src/activitypub.ts` の `adminOnly` ミドルウェアは
`process.env.FUNCTIONS_EMULATOR === 'true'` のとき**認証を無条件に通す**。
そのためエミュレータでは `X-Hakatashi-Token` なしで管理者エンドポイントを叩ける。

```
GET  /activitypub/createAdmin          actor を作成する
POST /activitypub/createPost           {"text": "..."} で投稿する
GET  /activitypub/publishProfileUpdate プロフィール更新を配信する
GET  /activitypub/pingTaskQueue        Cloud Tasks の疎通確認用タスクを1件発行する
GET  /activitypub/deliveries/failed    失敗中/リトライ中の配送を一覧する
POST /activitypub/deliveries/resend    {"activityId": "...", "inbox": "..."} で再送する
```

## Cloud Tasks のローカルテスト

`onTaskDispatched` を含む Function を `npm --prefix functions run serve` で起動すると、
Functions エミュレータが Cloud Tasks 用のキューを自動検出し、専用のエミュレータ
(ログ上は `tasks: ...Cloud Tasks Emulator`)を追加で起動する。`firebase.json` に
`emulators.tasks` の設定を書く必要はなく、実際の GCP プロジェクトの Cloud Tasks とも無関係に
ローカルだけで完結する。`getFunctions().taskQueue(name).enqueue()` を呼ぶと、
このローカルキューがほぼ即座に対応する `onTaskDispatched` ハンドラを実行する。

`GET /activitypub/pingTaskQueue` はこの確認用エンドポイントで、叩くと `pingTask` へタスクを
1件発行する。ハンドラ側の実行結果はエミュレータのコンソールログに
`{"type":"pingTaskReceived", ...}` として出力される(実際に Cloud Tasks へネットワーク越しに
発行されるわけではないため、権限設定の確認にはならない。権限まわりは dev 環境への実デプロイで
確認する)。

## 非正規化データの再計算

`userInfos` の投稿数や `streams` の `_meta.objectType` は
Firestore Trigger で非正規化されている。既存データを再計算するワンショットスクリプトがある。

```bash
# functions/bin/denormalizations.ts
# npm scripts には登録されていない。ts-node 等で手動実行する
```

フォロー関係の射影と `followers_count` / `following_count` は `functions/bin/backfillFollowProjection.ts` で
streams の Follow から組み立て直す(→ [ADR-0082](../adr/0082-project-follow-relations-in-store.md))。

`objects` の検索用フィールド(`_meta.attributedTo` / `inReplyTo` / `preferredUsername`)は
`functions/bin/backfillObjectQueryMeta.ts` で埋め直す(`--dry-run` で件数だけ確認できる。
→ [ADR-0086](../adr/0086-normalize-object-query-fields-into-meta.md))。

対象プロジェクトを間違えないよう、実行前に `GCLOUD_PROJECT` を確認すること。

## デプロイ

`main` への push で CI が自動デプロイする(`.github/workflows/main.yml`)。
**本番 `activitypub-firebase` と dev `activitypub-firebase-dev` の両方に同時にデプロイされる。**

手動でデプロイする場合:

```bash
npm --prefix functions run deploy                    # functions のみ
firebase deploy --only functions,firestore -P dev    # dev プロジェクト
```

## 秘密情報

`HAKATASHI_TOKEN` は Secret Manager で管理されている
(`functions/src/activitypub.ts` の `params.defineSecret`)。

**ログに秘密鍵やトークンを出力しないこと。** リクエストヘッダは `functions/src/utils.ts` の
`pickSafeHeaders` で許可リスト方式にし、レスポンスボディは `redactSensitiveBody` で
機微なフィールドをマスクしている。新しいログ出力を追加する際もこの方式に合わせること。
