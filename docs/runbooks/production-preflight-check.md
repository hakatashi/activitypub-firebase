# 本番環境の点検(移行前)

引っ越し(Epic [#10](https://github.com/hakatashi/activitypub-firebase/issues/10))の前に、
本番(`hakatashi.com`)のデータ・設定・ログを点検する手順。初回は #263 で行い、
移行の直前(#273)と、引っ越しの手順書(`account-migration.md`、#270)の Go / No-Go 判定でも同じ手順を繰り返す。

**すべて読み取りだけで行う。** 差分が見つかっても、この手順の中でバックフィルの本実行や再送をしない。
直す必要があれば個別の Issue にし、本実行はユーザーの承認を得てから行う。

## 実行

```bash
gcloud auth application-default login   # 本番の Firestore を読める ADC
gcloud auth login                       # gcloud logging / tasks / secrets を読める権限

functions/bin/preflightCheck.sh activitypub-firebase                 # すべて
functions/bin/preflightCheck.sh activitypub-firebase data external   # 一部だけ (data / infra / logs / external)
FRESHNESS=7d functions/bin/preflightCheck.sh activitypub-firebase logs
```

dev(`activitypub-firebase-dev`)に向けても同じように動くので、スクリプトを変えたら先に dev で試す。

スクリプトが出力しないもの:

- 秘密鍵(`checkActorKeyPair.ts` は公開鍵の指紋と判定だけを出す)
- `HAKATASHI_TOKEN` の値(管理者エンドポイントに入れたかどうかのステータスだけを出す)

## 判定の基準

### 1. データの整合性(`data`)

| 項目 | 正常 |
|---|---|
| `backfill*.ts --dry-run`(射影・`_meta`・返信数) | `written` / `deleted` / `updated` がすべて 0 |
| `assignMastodonIds.ts --dry-run` | `unassigned: 0` |
| `backfillNotificationProjection.ts --dry-run` | `unassigned: 0`(未採番のアクティビティがない) |
| `reconcilePendingFollows.ts --dry-run` | `pendingFollows` が空(承認漏れの Follow がない、ADR-0075) |
| `checkActorKeyPair.ts` | `matches: true` |
| followers コレクション | `totalItems` = `listed` = `unique`、`duplicate:` の行がない |

`--dry-run` は Mastodon ID の採番も含めて何も書き込まない。差分が出たら、本実行の前に原因を調べる
(バックフィルの実行漏れなのか、差分更新の不具合なのか)。

### 2. 設定とインフラ(`infra`)

- **デプロイ**: 直近の main の run で `Deploy to Firebase except for Hosting` が `success`。各 Function の最終更新が最後にマージした変更より後。
  Hosting のジョブだけ成功して Functions のデプロイが失敗していることがあり、その場合は main にあるコードが本番に入っていない(→ #280)。
- **インデックス**: `missing` が空。`extra` は過去の実験やクエリの変更で残ったもので、それだけでは問題ない
  (削除するなら不要と確かめてから。`firebase deploy` に `--force` を付けて消さない)。
- **TTL ポリシー**: `defined` のすべてが `deployed ... ACTIVE` にある。
- **Cloud Tasks**: `state: RUNNING`、`rateLimits` / `retryConfig` が `functions/src/tasks.ts` と一致し、`pending tasks` が 0 か、
  リトライ待ちとして説明がつく件数。
- **`HAKATASHI_TOKEN`**: `GET /activitypub/deliveries/failed -> 200`。

### 3. ログと配送の記録(`logs`)

- `severity>=ERROR` を Function(サービス)と `jsonPayload.type` ごとに見て、原因の分からないものがない。既知のもの:
  - `mastodonapi` の型なしの ERROR の大半は、脆弱性スキャナが未実装のパス(`/api/.env` など)を叩いた 501 のリクエストログ
  - デプロイ直後の `FAILED_PRECONDITION: ... index is currently building` は、インデックスの構築が終われば消える
  - サービス名のない監査ログの `Permission denied to enable service [firebaseextensions.googleapis.com]` は、CI のデプロイが API の有効化を試みているだけ
- inbox の応答の **4xx** を1件ずつ見る。4xx は送信元にとって恒久的な失敗で、フォロワーを失う原因になる(→ #260、ADR-0115)。
  署名の検証に失敗した 401 は、鍵を失ったアカウントからの Delete などで普通に起きるので、送信元で判断する。
- 失敗・リトライ中の配送: `attempts` が 5(`maxAttempts`)に達した `retrying` は実質的な失敗(→ [federation-testing.md](federation-testing.md))。
  宛先ホストごとに偏っていないか、原因が分かっているかを見る。

### 4. 外部から見た状態(`external`)

- WebFinger の `subject` が `acct:hakatashi@hakatashi.com` で、`links[rel=self]` が actor を指す(1段で完結する、ADR-0008)。
- nodeinfo が取れる。
- actor の `preferredUsername` / `inbox` / `followers` / `publicKey` が正しい。`Accept: text/html` で actor IRI を開くと Elk に飛ぶ
  (actor に `url` はない。Mastodon は `url` がなければ actor IRI をプロフィールのリンクに使う)。
- `activitypub-testing` で `passed` が7件(`cantTell` / `inapplicable` の扱いは [federation-testing.md](federation-testing.md))。

スクリプトの外で、ブラウザで行うもの:

- **pawoo.net の Web UI で `@hakatashi@hakatashi.com` を検索して表示できる**(フォローはしない。ADR-0014)。
  表示名・アバター・投稿数が本番と一致しているか。pawoo.net のキャッシュは古いことがあるが、
  Move の実行時は `ResolveAccountService` が `skip_cache: true` で actor を取り直す(`app/models/account_migration.rb`)。
