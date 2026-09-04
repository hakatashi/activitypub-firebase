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
npm --prefix functions run build      # tsc
npm --prefix functions run build:watch
npm --prefix functions run lint       # eslint
```

`tsconfig.json` の `include` は `src` のみ。`test/` と `bin/` はビルド対象外。

## テスト

Firestore エミュレータを起動した上で Vitest を実行する。npm script が両方をまとめている。
テストランナーの選定理由は [ADR-0011](../adr/0011-vitest-over-jest.md) を参照。

```bash
npm --prefix functions test
npm --prefix functions run test:watch
```

内部では以下を行っている。

- `firebase emulators:exec --only firestore` でエミュレータを起動(ポートは `firebase.json` で 34567)
- `GCLOUD_PROJECT=activitypub-firebase-dev` を設定する。
  これにより `functions/src/firebase.ts` の分岐が dev ドメイン
  (`activitypub-dev.hakatashi.com`)を返す
- `vitest.config.ts` の `test.fileParallelism: false` でテストファイルを直列実行する。
  テストが Firestore エミュレータを共有し、各テストが全データを消去するため必須

### ディレクトリ構成

- `test/unit/` — 外部 I/O のない純粋関数、または Firestore エミュレータのみに依存するテスト
  (`store.ts` の各メソッドなど)。ネットワークや実際の ActivityPub 連合には依存しない。
- `test/integration/` — Express アプリ(`activitypub` / `mastodonApi`)に対して
  `supertest` でリクエストを送るテスト。

どちらも Firestore エミュレータを使う場合は、各テストの `afterEach` でエミュレータの
`DELETE /emulator/v1/projects/{id}/databases/(default)/documents` を叩き、全データを消去する。
新しいテストを書く際もこの方式に合わせること(`test/unit/store.spec.ts` や
`test/integration/*.spec.ts` を参照)。

`vitest.config.ts` は Vite のネイティブな TypeScript/ESM 変換を使うため、
Jest 時代のような `moduleNameMapper` での `./x.js` → `./x` 解決は不要。

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

`userInfos` の投稿数・フォロワー数や `streams` の `_meta.objectType` は
Firestore Trigger で非正規化されている。既存データを再計算するワンショットスクリプトがある。

```bash
# functions/bin/denormalizations.ts
# npm scripts には登録されていない。ts-node 等で手動実行する
```

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
