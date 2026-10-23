# AGENTS.md

ActivityPub を Firebase 上でフルサーバーレスに実装するプロジェクト。
Mastodon 互換 API も提供し、Elk などのサードパーティクライアントをフロントエンドとして使う。
ユーザーは `@hakatashi@hakatashi.com` の1人のみを想定している。

**このファイルは地図とルールだけを置く。決定の理由は ADR に、進捗は GitHub Issue にある。**

## ドキュメントの地図

| 知りたいこと | 読む場所 |
|---|---|
| 今どういう構成になっているか | [`docs/architecture.md`](docs/architecture.md) |
| **なぜそう作られているか** | [`docs/adr/`](docs/adr/README.md) |
| 次に何をすべきか | オープンな GitHub Issue(進め方は [`docs/roadmap.md`](docs/roadmap.md)) |
| 壊れている箇所・技術的負債 | [`docs/known-issues.md`](docs/known-issues.md) |
| Mastodon API のどこまで実装したか | [`docs/mastodon-api-coverage.md`](docs/mastodon-api-coverage.md) |
| ActivityPub 仕様(S2S)のどこまで準拠しているか | [`docs/activitypub-s2s-compliance.md`](docs/activitypub-s2s-compliance.md) |
| ビルド・テスト・デプロイの方法 | [`docs/runbooks/local-development.md`](docs/runbooks/local-development.md) |
| 連合が動くことをどう確認するか | [`docs/runbooks/federation-testing.md`](docs/runbooks/federation-testing.md) |
| Elk などのクライアントで動くことをどう確認するか | [`docs/runbooks/client-testing.md`](docs/runbooks/client-testing.md) |
| Firestore の読み取り回数と月額をどう見積もるか | [`docs/runbooks/measure-firestore-reads.md`](docs/runbooks/measure-firestore-reads.md) |
| 本番のデータ・設定・ログをどう点検するか(移行前) | [`docs/runbooks/production-preflight-check.md`](docs/runbooks/production-preflight-check.md) |
| pawoo.net からの引っ越しをどう実行・監視するか | [`docs/runbooks/account-migration.md`](docs/runbooks/account-migration.md) |
| ボット用インスタンスでボットを作り、外部から投稿させる方法 | [`docs/runbooks/bot-instance.md`](docs/runbooks/bot-instance.md) |
| Claude Code のクラウドセッションで作業するときの注意 | [`docs/runbooks/cloud-session.md`](docs/runbooks/cloud-session.md) |

`third_party/` には仕様書と参考実装が submodule として置かれている
(`activitystreams` / `activitypub` = W3C 仕様、`mastodon` / `mastodon_documentation` = Mastodon 本体とドキュメント、
`misskey` = Misskey 本体、
`minidon` / `minipub` = サーバーレス寄りの軽量実装、`elk` / `phanpy` = フロントエンドとして使うクライアントのソース、`rfc/` = WebFinger と acct URI の RFC)。
**仕様の確認は推測ではなくこれらを読んで行うこと。**

## 作業のルール

### ドキュメント

- **設計判断をしたら、実装を始める前に [`docs/adr/`](docs/adr/README.md) に ADR を追加する。**
  1決定1ファイル、50行以内。既存の ADR は書き換えず、新しい ADR で supersede する。
- このファイルに決定の理由を書かない。ADR にリンクする。
- **進捗・TODO をドキュメントに書かない。** GitHub Issue に書く。
- `docs/architecture.md` は現時点の姿だけを書く。履歴を残さない。
- `docs/known-issues.md` は直したら消す。履歴は git が持っている。

### GitHub Issue

- **思いついた時点で起票してよい。** `area:*` と、種別として `enhancement` / `bug` を付ける。
  着手前に ADR が必要なら `needs-adr` を付ける(→ [ADR-0130](docs/adr/0130-continuous-improvement-after-phase5.md))。
- `phase:*` ラベル・フェーズの Milestone・Epic の sub-issue は付けない(下記「過去のフェーズ」)。
- 他の Issue の前提になる・他の Issue を待つ場合は、GitHub の blocked by / blocking を設定する。
- 大きな機能で複数の Issue を束ねたくなったら、その機能単位の親 Issue に sub-issue をぶら下げてよい。
- 連合を壊さないこと(配送・受信・WebFinger)を機能追加より常に優先する。

#### 過去のフェーズ

このプロジェクトは 2026-10 の pawoo.net からの引っ越しの完了まで、**Phase 0〜5 のフェーズに分けて進めていた。**
各フェーズに Epic Issue と Milestone があり、Issue には `phase:N` ラベルが付いている。
古い ADR・Issue・PR・レポートに出てくる「Phase N」はこれを指す。今はフェーズによる管理を行わない
(→ [ADR-0130](docs/adr/0130-continuous-improvement-after-phase5.md))。

| Phase | 内容 | Epic |
|---|---|---|
| 0 | 開発基盤 | [#5](https://github.com/hakatashi/activitypub-firebase/issues/5) |
| 1 | 配送 | [#6](https://github.com/hakatashi/activitypub-firebase/issues/6) |
| 2 | 受信と AP 準拠 | [#7](https://github.com/hakatashi/activitypub-firebase/issues/7) |
| 2.5 | apex フォーク | [#103](https://github.com/hakatashi/activitypub-firebase/issues/103) |
| 3 | Mastodon API | [#8](https://github.com/hakatashi/activitypub-firebase/issues/8) |
| 3.5 | リファクタリング | [#181](https://github.com/hakatashi/activitypub-firebase/issues/181) |
| 4 | 通知・メディア・検索など | [#9](https://github.com/hakatashi/activitypub-firebase/issues/9) |
| 5 | pawoo.net からの引っ越し | [#10](https://github.com/hakatashi/activitypub-firebase/issues/10) |

### プルリクエスト

- **対応する Issue がある変更は、原則として PR の本文に `Closes #N` などクローズ用の構文を入れる。**
  対応する Issue がない変更の場合は、Issue への紐付けは強制せず、そのまま PR を作成してよい。

### 検証

- **dev 環境で検証可能な変更は、PR を作成する前に積極的に dev 環境へデプロイして検証する。**
  連合が絡む変更は [`docs/runbooks/federation-testing.md`](docs/runbooks/federation-testing.md)
  の手順に従い、外部インスタンスとの疎通まで確認する(連合の不具合はローカルでは再現しない)。
- **Mastodon API などクライアントから見える挙動が絡む変更のうち必要なものは、PR を作成する前に
  [`docs/runbooks/client-testing.md`](docs/runbooks/client-testing.md) の手順に従って検証する**
  (federation-testing.md と同様)。
- **dev 環境は検証用のデプロイ環境であり、検証のために既存データを破壊してよい。**
  本番相当のデータを維持する必要はない。
- デプロイ手順(dev 限定の手動デプロイ、バックフィルスクリプトの実行方法を含む)は
  `deploy-firebase` skill を使う。

### コード

- `main` への push で **本番と dev の両環境に自動デプロイされる。** 直接 push しない。
- 秘密鍵・アクセストークン・`Authorization` ヘッダをログに出力しない。
- Firestore へのクライアントからの直接アクセスは全面禁止されている。
  すべて Cloud Functions 経由。
- **PR を作成する前に `build` / `typecheck` / `lint` / `format:check` / `test` を全て実行し、
  通ることを確認する。**
- **apex のフォーク (`functions/src/apex/`) から `firebase-admin` / `firebase-functions` /
  本体のモジュールを import しない。** フォークと本体の責務境界は
  [ADR-0042](docs/adr/0042-apex-fork-responsibility-boundary.md) が定める。
  境界をまたぎたくなったら、それは「その処理は本体側の責務だ」というシグナル。
  apex ライブラリ自体の単体テストは `functions/test/unit/apex/` に配置する。

## よく使うコマンド

```bash
npm --prefix functions ci             # 依存のインストール
npm --prefix functions run build      # tsc(src のみ、lib/ へ出力)
npm --prefix functions run typecheck  # tsc --noEmit(src / test / bin)
npm --prefix functions run lint       # oxlint
npm --prefix functions run format     # oxfmt(自動整形)
npm --prefix functions run format:check # oxfmt(整形チェックのみ)
npm --prefix functions test           # Firestore エミュレータ + vitest
npm --prefix functions run test:changed # 変更に関係するテストのみ実行
```

## 現在の状態と優先事項

**ロードマップの最終目的はすべて達成した**(→ [`docs/roadmap.md`](docs/roadmap.md))。
2026-10-17 に pawoo.net で `Move` を実行し、`@hakatashi@hakatashi.com` が本番のアカウントになった
(手順と本番で起きたことは [`docs/runbooks/account-migration.md`](docs/runbooks/account-migration.md))。
**本番には実在のフォロワーがいる。** 連合を壊す変更は、そのままフォロワーを失うことにつながる。

配送は Cloud Tasks 経由で動作し(→ [ADR-0003](docs/adr/0003-delivery-via-cloud-tasks.md))、
Follow / Accept / Create / Like / Announce / Undo / Inbox Forwarding を実在のインスタンスとの間で確認済み
(→ [`docs/runbooks/federation-testing.md`](docs/runbooks/federation-testing.md))。
apex は `functions/src/apex/` にフォークして TypeScript で保守している
(→ [ADR-0040](docs/adr/0040-fork-activitypub-express.md)、
[ADR-0042](docs/adr/0042-apex-fork-responsibility-boundary.md))。
**apex の不具合はフォーク側で直す。本体側に回避コードを書かない。**

Mastodon API は Elk / Phanpy から投稿・閲覧・タイムライン・通知・メディア添付・検索などが一通りでき、
時系列順の Mastodon ID(→ [ADR-0006](docs/adr/0006-mastodon-api-id-scheme.md))でページネーションしている。
通知などのユーザー別のデータは、Store がアクティビティを書き換えるのと同じトランザクションで
`userInfos/{actor}` のサブコレクションに射影する
(→ [ADR-0082](docs/adr/0082-project-follow-relations-in-store.md)、[ADR-0088](docs/adr/0088-project-notifications-in-store.md))。
クライアントでの確認は [`docs/runbooks/client-testing.md`](docs/runbooks/client-testing.md) の手順で行う。

以後は継続改善の Issue を順に片付ける(→ [ADR-0130](docs/adr/0130-continuous-improvement-after-phase5.md))。
引っ越しで見つかった問題(inbox が恒久的な失敗にも 5xx を返すなど)は [`docs/known-issues.md`](docs/known-issues.md) にある。
