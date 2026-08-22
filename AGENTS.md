# AGENTS.md

このファイルは、このリポジトリで作業するAIエージェント(および人間)向けに、プロジェクトの現状をまとめたものです。2026-08-22時点の調査結果に基づきます。

## プロジェクト概要

ActivityPubをFirebase上でフルサーバーレスに実装する試み。2023-07-09〜2023-07-30の約3週間に集中的に開発され、それ以降は実質的なコード変更が止まっている(Dependabotによる依存関係更新など自動コミットのみ)。`public/` ディレクトリは無関係な個人サイト(hakatashi.com)のgit submoduleであり、本プロジェクトのコードではない。実装本体は `functions/` 以下にある。

## アーキテクチャ

- **構成**: Firebase Hosting + Cloud Functions (Gen2, Node 20) + Firestore。TypeScript / ESM。
- **Firestoreルール**: クライアントからの読み書きは全面禁止(`firestore.rules`)。すべてCloud Functions経由(Admin SDK)でアクセスするサーバーレス設計。
- **2つの独立したFunctions/ホスティングターゲット**:
  - `activitypub` function → `hakatashi.com`: ActivityPubプロトコル本体(actor, inbox/outbox, webfinger, nodeinfo等)。`functions/src/activitypub.ts`。
  - `mastodonApi` function → `mastodon.hakatashi.com`: Mastodon互換REST API + 独自OAuth2サーバー。`functions/src/mastodon/`。
- **ActivityPubプロトコル実装**: 自前実装ではなく `activitypub-express`(apex)ライブラリに委譲。署名検証・JSON-LD処理・webfinger/nodeinfoルーティングなどを提供。
- **ストレージ層**: apexの `IApexStore` インターフェースをFirestoreで実装した `functions/src/store.ts`(448行)。プロジェクトで最も手間のかかる部分であり、実装は完了している。
  - FirestoreのドキュメントIDはURLをそのまま使えないため、`escapeFirestoreKey`/`unescapeFirestoreKey`(`functions/src/firebase.ts`)で `%`, `/`, `.` をエスケープしている。
  - `objects`(actor/note等のオブジェクト)、`streams`(inbox/outboxのアクティビティ)、`deliveryQueue`(配送キュー)、`contexts`(JSON-LDコンテキストキャッシュ)の各Firestoreコレクションを使用。
- **非正規化(denormalization)**: apexのストア抽象化ではフォロワー数・投稿数などの集計ができないため、Firestore Triggers(`functions/src/denormalizations.ts` の `onDocumentWritten`/`onDocumentCreated` on `streams/{streamId}`)で `userInfos` コレクションに非正規化している。`functions/bin/denormalizations.ts` は既存データを再計算するワンショットスクリプト。
- **UI方針**: 自前のWeb UIは作らず、Mastodon互換API + 独自OAuth2サーバー(`@node-oauth/oauth2-server`)を用意し、Firebase Authentication(Googleログイン、`hakatasiloving@gmail.com` のみ許可、`functions/src/mastodon/index.ts` の `beforeUserCreate`)で認証させ、既存のMastodon Webクライアント「Elk」(`elk.zone`)をそのままフロントエンドとして使う設計。actorページへのアクセスもElkにリダイレクトされる。

## 実装済みの機能

- apex経由のActor/Inbox/Outbox/Webfinger/Nodeinfo/HTTP署名検証
- FirestoreバックエンドのStore全メソッド(オブジェクト、アクティビティ、コンテキストキャッシュ、配送キューのenqueue/dequeue/requeue)
- Followの自動承認(受信したFollowに対して自動でAcceptを返信、`functions/src/activitypub.ts` の `apex-inbox` イベントリスナー)
- 管理者(hakatashi)専用のactor作成・投稿作成エンドポイント(`X-Hakatashi-Token` ヘッダによるトークン認証、`/activitypub/createAdmin`, `/activitypub/createPost`)
- Mastodon APIの一部: `/v1/instance`, `/v2/instance`, アカウントlookup, フォロワー一覧, タイムライン(public/home), preferences, OAuth認可コードフロー+トークン発行(`/oauth/authorize`, `/oauth/token`), クライアントアプリ登録(`/api/v1/apps`)
- CI(`.github/workflows/main.yml`): mainへのpushでテスト・lint実行後、本番(`activitypub-firebase`)・開発(`activitypub-firebase-dev`)の両Firebaseプロジェクトへ自動デプロイ

## 未実装・既知の問題

優先度が高い順。

1. **配送(デリバリー)キューを処理するワーカーが存在しない(最重要)**。`deliveryEnqueue`/`deliveryDequeue`/`deliveryRequeue`はStoreに実装済みだが、apexはこれを内部の `setInterval` ループ(常駐プロセス前提)で処理する設計になっている。Cloud Functionsには常駐プロセスがなく、これを起動する `onSchedule` やCloud Tasks連携などの仕組みが一切ない。つまり投稿やAcceptを `deliveryQueue` に積んでも、実際にリモートのinboxへHTTP配送される経路が存在しない可能性が高い。これはapexの「常駐ワーカー」モデルとCloud Functionsの「サーバーレス」モデルの根本的なミスマッチであり、「完全サーバーレスでActivityPubを実装する」という当初目的の達成を妨げている中心的な課題。
2. **Mastodon APIから投稿できない**。`POST /api/v1/statuses` が未実装(未定義ルートは501にフォールバック)。投稿は管理者トークン付きの `/activitypub/createPost` を手動で叩くしかなく、Elk等のMastodonクライアントからは投稿できない。
3. **マルチユーザー/タイムライン分離が機能していない**。`functions/src/mastodon/api.ts` の `getAllNotes()` は全Noteを無条件に返しており、アクター単位のフィルタも公開範囲(visibility)判定もない。事実上シングルユーザー・シングルタイムライン設計。
4. メディア添付・検索・通知・ストリーミングAPI・ブロック/ミュート/お気に入り/ブースト等のAPI連携が未実装(instance設定でも上限0で明示的に無効化されている)。
5. テストが薄い(`functions/test/integration/` に2ファイル・177行のみ)。Mastodon API側のロジック(account/timeline構築、OAuthフロー)はほぼ未テスト。

## 依存関係

- `activitypub-express`(apex): npm上の最終更新は2024-02(v4.4.2)。完全に放置はされていないが更新は緩やか。
- Firebase Functions v4 / Firebase Admin v11 / Node 20 / TypeScript 4.9。いずれも現時点でやや古いバージョン帯なので、着手時にアップグレード検討の余地がある。

## デプロイ構成

- `firebase.json` / `.firebaserc`: 本番プロジェクト `activitypub-firebase`、開発プロジェクト `activitypub-firebase-dev` の2環境。
- ドメイン: 本番は `hakatashi.com`(ActivityPub)/`mastodon.hakatashi.com`(Mastodon API)、開発は `activitypub-dev.hakatashi.com`/`mastodon-dev.hakatashi.com`。
