# アカウントの引っ越し(pawoo.net → hakatashi.com)

`@hakatashi@pawoo.net` から `@hakatashi@hakatashi.com` へ引っ越す手順(Epic [#10](https://github.com/hakatashi/activitypub-firebase/issues/10))。
リハーサル(#272)と本番(#273)の両方でこの手順書どおりに実行し、リハーサルで見つかった抜けを書き足してから本番に臨む。

**引っ越しはやり直せない。** 当日に判断を迷わないよう、判断の基準はすべてここに書く。ここにない判断が必要になったら、手を止めて Issue に書く。

リハーサルでは次のとおり読み替える。

| 本番 | リハーサル |
|---|---|
| 旧アカウント `hakatashi@pawoo.net` | 検証用 Mastodon(`mastodon-test.hakatashi.com`)/ 検証用 Misskey の旧アカウント |
| `activitypub-firebase` / `hakatashi.com` | `activitypub-firebase-dev` / `activitypub-dev.hakatashi.com` |
| `functions/.env` の変更を main にマージ | `gcloud run services update ... --min-instances=1`(→ [federation-testing.md](federation-testing.md) の 13) |

## 0. 共通の準備

スクリプトはすべて `functions/` で `tsx` を使って実行する。**本番に向けるときは `GCLOUD_PROJECT` と `FIREBASE_CONFIG` の両方を指定する**
(`FIREBASE_CONFIG` がないと `src/firebase.ts` の `domain` が dev にフォールバックする。→ `deploy-firebase` skill)。
各スクリプトが最初に出す `Loading local actor: https://hakatashi.com/...` の行で、対象を必ず確かめる。

```bash
gcloud auth application-default login
gcloud auth login
cd functions
export GCLOUD_PROJECT=activitypub-firebase
export FIREBASE_CONFIG='{"projectId":"activitypub-firebase"}'
export DOMAIN=hakatashi.com
export HAKATASHI_TOKEN=$(gcloud secrets versions access latest --secret=HAKATASHI_TOKEN --project=$GCLOUD_PROJECT)
mkdir -p ~/migration   # 旧アカウントのデータと各時点の記録を置く(リポジトリに入れない)
```

## 1. 取り消せない操作と、やり直しの手段

| 操作 | 取り消せるか | やり直しの手段 |
|---|---|---|
| 旧アカウントで Move を実行する | **できない。** 30日間は再実行できない(`AccountMigration::COOLDOWN_PERIOD`)。旧アカウントには `movedTo` が付き、投稿できなくなる | **移行の再実行(`MoveService`)は旧サーバーの管理者しかできない。** pawoo.net の運営に頼ることは期待しない |
| Move を受けたサーバーでの処理 | できない。各サーバーで7日に1回だけ処理される(`move.rb` の `PROCESSING_COOLDOWN`) | そのサーバーのフォロワーに個別に連絡してフォローし直してもらう |
| 引っ越しの Follow にこちらが 4xx を返す | できない。401 / 408 / 429 以外の 4xx は再送されず、旧アカウントのフォローも外れる(`MigratedFollowDeliveryWorker`) | 個別に連絡してフォローし直してもらう |
| フォローのインポート(相手へ Follow を配送) | 解除はできる(Undo を配送) | 外したい相手を Elk でフォロー解除する |
| 別名(`alsoKnownAs`)の設定 | **できる。** それ自体は無害 | `manageAliases.ts remove` |
| 投稿履歴のインポート | 外への影響はない(配送しない)。ただし消すスクリプトはない(`deleteLocalStatuses.ts` は `_meta.legacyUri` のある Note を対象外にする) | 冪等なので、途中で止まったら再実行する。消す必要が出たら `_meta.legacyUri` で見分けるスクリプトを作る(→ [ADR-0126](../adr/0126-import-post-history-from-mastodon-archive.md)) |

## 2. 前提条件のチェックリスト(Go / No-Go)

**1つでも満たさなければ、Move を実行しない(No-Go)。**

- [ ] Epic #10 の事前点検の Issue(#258 #259 #260 #261 #262 #263 #271 と、それらから派生した Issue)がすべて閉じている
- [ ] リハーサル(#272)で、3つの経路のすべてでフォロワーが全員移ってきた(移らなかった相手は原因が説明できる)
- [ ] 本番の点検([production-preflight-check.md](production-preflight-check.md))を、**実行の前日以内に**もう一度行い、判定の基準をすべて満たす。特に:
  - 直近の main の run で `Deploy to Firebase except for Hosting` が `success`(main のコードが本番に入っている)
  - inbox の 4xx がない(あれば1件ずつ説明がつく)
  - `reconcilePendingFollows.ts --dry-run` の `pendingFollows` が空
  - `checkActorKeyPair.ts` が `matches: true`
  - WebFinger が1段で解決し、actor に `alsoKnownAs` が出ている(手順3の後)
- [ ] `activitypub` Function の最小インスタンス数が本番で 1 になっている(手順2。→ [ADR-0113](../adr/0113-temporary-min-instances-during-migration.md)、[ADR-0116](../adr/0116-dotenv-for-functions-params.md))
  ```bash
  gcloud functions describe activitypub --region=asia-northeast1 --project=activitypub-firebase \
    --format='value(serviceConfig.minInstanceCount)'   # → 1(0 のときは空になる)
  ```
- [ ] **デプロイの凍結を宣言した。** Move の前日から3日後までは main にマージしない。main への push は本番に自動デプロイされ、全インスタンスが入れ替わる(例外は「5. 問題が起きたときの対処」)
- [ ] 移行の前後でローカル actor の鍵をローテーションしない(`functions/bin/rotateActorKey.ts`、[ADR-0009](../adr/0009-rotate-actor-key-before-delivery.md))。Move を処理するサーバーが鍵をキャッシュしている
- [ ] 旧アカウントで、移行フォームの本人確認を通れることを確かめた。
  pawoo.net の `@hakatashi` は pixiv の OAuth 連携でログインしており、パスワードがない。
  Mastodon 4.1.18 の移行フォームは、パスワードが設定されていなければ**現在のユーザー名**(`hakatashi`)の入力を求める(`AccountMigration#save_with_challenge`)。
  フォームを開いて入力欄が「現在のユーザー名」になっていることだけを確かめ、送信しない
- [ ] 旧アカウントのデータを保存した(pawoo.net の「設定 > インポート・エクスポート > データのエクスポート」)。**アーカイブは7日に1回しか要求できないので、早めに要求する**
  - [ ] アーカイブ(`archive-*.tar.gz`)
  - [ ] フォロー(`following_accounts.csv`)、ブックマーク(`bookmarks.csv`)
- [ ] 旧アカウントのフォロワー一覧を保存した(手順4。Move の後は旧アカウントのフォロワーが減っていくので、**Move の前に**保存したものを基準にする)
- [ ] 当日、Move の実行から少なくとも3時間は張り付いて監視できる

## 3. 実行の手順

順番に意味がある。各手順の出力は `~/migration/` にテキストで残す。

### 3.1. 数日前

1. **プロフィールを揃える。** 新アカウントの表示名・自己紹介・アバター・ヘッダー・プロフィールの補足情報を Elk から旧アカウントに合わせる。
   旧アカウントで、新アカウントへ引っ越すことを予告する投稿をする(任意)。
2. **最小インスタンス数を 1 にする。** `functions/.env` を `ACTIVITYPUB_MIN_INSTANCES=1` にする PR を作り、main にマージする。
   デプロイ後、チェックリストのコマンドで `1` を確かめる。
3. **フォローとブックマークをインポートする**(→ [ADR-0124](../adr/0124-import-following-and-bookmarks-from-csv.md))。
   引っ越しの直後は inbox が混み合うので、Move の数日前に済ませる。中断しても再実行してよい(冪等)。
   ```bash
   npx tsx bin/importFollowing.ts ~/migration/following_accounts.csv --dry-run
   npx tsx bin/importFollowing.ts ~/migration/following_accounts.csv | tee ~/migration/import-following.log
   npx tsx bin/importBookmarks.ts ~/migration/bookmarks.csv --dry-run
   npx tsx bin/importBookmarks.ts ~/migration/bookmarks.csv | tee ~/migration/import-bookmarks.log
   ```
   `Moved to new actor` に出た相手は、引っ越し先を Elk で手動でフォローする。`Failed` は理由を見て、必要なら手動でフォローする。

### 3.2. 前日

4. **本番の点検をする**(チェックリストを参照)。
5. **旧アカウントのフォロワー一覧を保存する**(→ [ADR-0125](../adr/0125-migration-progress-reconciliation-and-pre-delivery.md))。
   ```bash
   npx tsx bin/migrationStatus.ts --account=hakatashi@pawoo.net --save=$HOME/migration/followers.json
   jq length ~/migration/followers.json   # pawoo.net のプロフィールのフォロワー数と比べる
   ```
6. **別名を設定する**(→ [ADR-0121](../adr/0121-actor-aliases-via-also-known-as.md))。追加と同時に `Update(Person)` がフォロワーへ配送される。
   ```bash
   npx tsx bin/manageAliases.ts add hakatashi@pawoo.net
   npx tsx bin/manageAliases.ts list   # → ["https://pawoo.net/users/hakatashi"]
   curl -s -H 'Accept: application/activity+json' https://$DOMAIN/activitypub/u/hakatashi | jq .alsoKnownAs
   ```
   **actor の URI(`https://pawoo.net/users/hakatashi`)と完全一致していること。** `acct:` 形式やプロフィールの URL(`/@hakatashi`)では検証に失敗する。
7. **旧アカウントのフォロワーがいるサーバーへ `Update(Person)` を事前に配送する。** 相手の `UnavailableDomain` の記録を消し、`alsoKnownAs` を含む actor を取らせる。
   ```bash
   npx tsx bin/migrationStatus.ts --file=$HOME/migration/followers.json --announce --dry-run
   npx tsx bin/migrationStatus.ts --file=$HOME/migration/followers.json --announce --force | tee ~/migration/announce.log
   ```
   `Unresolved Domains` に出たサーバーは、引っ越しの Follow が届かない可能性が高い。個別に連絡する候補として控える。
   1時間ほど後に `deliveries/failed`(「4. 監視」)を見て、事前配送が失敗したサーバーがないか確かめる。
8. **移行前の状態を記録する。** 突き合わせの基準になる。
   ```bash
   npx tsx bin/migrationStatus.ts --file=$HOME/migration/followers.json | tee ~/migration/status-before.txt
   ```

### 3.3. 当日

9. **Go / No-Go を判定する。** チェックリストを上から確かめ、すべて満たしたら Go。
10. **Move を実行する。** pawoo.net の「設定 > アカウント > 別のアカウントへの引っ越し」で、
    引っ越し先に `hakatashi@hakatashi.com`、本人確認に現在のユーザー名を入力して送信する。
    - エラー「not an alias of this account」(この引っ越し先は別名に含まれていない)が出た場合、**このエラーでは何も実行されていない。**
      手順6のコマンドで `alsoKnownAs` を確かめ、直してから再試行してよい。
    - 送信が成功した時刻を記録する。
11. 監視する(「4. 監視」)。

### 3.4. 落ち着いてから

12. **投稿履歴をインポートする**(→ [ADR-0126](../adr/0126-import-post-history-from-mastodon-archive.md)、[ADR-0127](../adr/0127-import-archive-media-attachments.md))。
    配送は1件も起きない。引っ越しの Follow が落ち着いてから(目安: 72時間後の確認の後)行う。中断しても再実行してよい(冪等)。
    ```bash
    npx tsx bin/importArchive.ts ~/migration/archive-*.tar.gz --dry-run
    npx tsx bin/importArchive.ts ~/migration/archive-*.tar.gz | tee ~/migration/import-archive.log
    ```
    実行後、`deliveries` にインポートによる配送がないことを確かめる(実行中の時刻の `deliveryEnqueue` のログが、ほかの操作の分しかない)。
13. **後片付け。**
    - 最小インスタンス数を戻すか判断する。Move から1週間(各サーバーの `PROCESSING_COOLDOWN`)経って、新しい Follow が来なくなったら `ACTIVITYPUB_MIN_INSTANCES=0` に戻す PR をマージする
    - デプロイの凍結を解く
    - 移らなかったフォロワーの内訳と対応を #273 に記録する

## 4. 監視

Move の実行直後・1時間後・24時間後・72時間後に、次をすべて行う。

**進捗の突き合わせ。** サーバーごとに、移ってきたフォロワーの数を見る。
`[ALL PENDING - Move not processed?]` が付いたサーバーは、そのサーバーで Move が捨てられた可能性がある。
途中に出る JSON の WARNING(`ssrfBlockedUnresolvable`、`webfingerResolutionFailed` など)は、フォロワーのサーバーが既に消えている・応答しないことを示す。
そのサーバーのフォロワーは移ってこないので、移らなかった人数から除いて数える(2026-10-13 の時点で mstdn.poyo.me、meisskey.blue、mangadon.net などが該当)。
2回目以降は `--skip-remote` を付けると、未達のフォロワーの WebFinger の解決を省いて速く終わる。

```bash
npx tsx bin/migrationStatus.ts --file=$HOME/migration/followers.json | tee ~/migration/status-$(date +%Y%m%d-%H%M).txt
npx tsx bin/migrationStatus.ts --file=$HOME/migration/followers.json --json > ~/migration/status-$(date +%Y%m%d-%H%M).json
```

| 状態 | 意味 | 対処 |
|---|---|---|
| `followed` | 射影に入っている | なし |
| `follow_received_not_projected` | Follow は届いたが承認されていない | 承認し直す(下記) |
| `accept_delivery_failed` | Accept の配送が失敗・リトライ中 | 配送を再送する(下記) |
| `not_followed` | Follow が届いていない | 時間をおいて再確認。72時間後も残れば「5. 問題が起きたときの対処」 |

**承認漏れ。** inbox にあるが followers に入っていない Follow を見つけて承認し直す(→ [ADR-0111](../adr/0111-retry-unaccepted-follow-and-500-on-sync-failure.md))。

```bash
npx tsx bin/reconcilePendingFollows.ts --dry-run
npx tsx bin/reconcilePendingFollows.ts
```

**配送の失敗。** `Accept` の配送の失敗を見る。`attempts` が 5 に達した `retrying` は実質的な失敗。

```bash
curl -s -H "X-Hakatashi-Token: $HAKATASHI_TOKEN" https://$DOMAIN/activitypub/deliveries/failed |
  jq -r '.[] | "\(.inbox | split("/")[2])\t\(.status)\t\(.statusCode)\tattempts=\(.attempts)\t\(.activityId)"' | sort | uniq -c
# 再送する(activityId と inbox は上の出力から)
curl -s -X POST https://$DOMAIN/activitypub/deliveries/resend \
  -H "X-Hakatashi-Token: $HAKATASHI_TOKEN" -H 'Content-Type: application/json' \
  -d '{"activityId":"<activityId>","inbox":"<inbox>"}'
```

**inbox の応答とエラー。** inbox の 4xx は1件も出てはならない(1件ごとにフォロワーを1人失った可能性がある)。

```bash
INBOX_FILTER='resource.type="cloud_run_revision" AND resource.labels.service_name="activitypub" AND logName="projects/activitypub-firebase/logs/run.googleapis.com%2Frequests" AND httpRequest.requestMethod="POST" AND httpRequest.requestUrl:"/inbox"'
gcloud logging read "$INBOX_FILTER" --project=$GCLOUD_PROJECT --freshness=1h --limit=50000 \
  --format='value(httpRequest.status)' | sort | uniq -c
gcloud logging read "$INBOX_FILTER AND httpRequest.status>=400" --project=$GCLOUD_PROJECT --freshness=1h --limit=200 \
  --format='value(timestamp,httpRequest.status,httpRequest.latency,httpRequest.userAgent)'
gcloud logging read 'severity>=ERROR AND resource.labels.service_name=("activitypub" OR "deliverytask")' \
  --project=$GCLOUD_PROJECT --freshness=1h --limit=100 --format=json | jq -r '.[] | "\(.timestamp)\t\(.jsonPayload.message // .textPayload // "")"'
```

**配送キューの滞留。** Accept が溜まっていないか。数百件を超えて減らなければ、`deliveryTask` のエラーを見る。

```bash
gcloud tasks list --queue=deliveryTask --location=asia-northeast1 --project=$GCLOUD_PROJECT --format='value(name)' | wc -l
```

**フォロワー数。** Elk のプロフィールと、`curl -s -H 'Accept: application/activity+json' https://$DOMAIN/activitypub/u/hakatashi/followers | jq .totalItems`。

## 5. 問題が起きたときの対処

| 症状 | 対処 |
|---|---|
| `accept_delivery_failed`、相手で follow_request のまま | `deliveries/resend` で Accept を再送する。原因(相手の 5xx、署名)を `deliveries/failed` の `statusCode` / `error` で見る |
| `follow_received_not_projected` | `reconcilePendingFollows.ts` で承認し直す。`activitypub` Function の ERROR ログで承認が失敗した原因を見る |
| inbox が 5xx を返している | 相手は再送してくるので、慌てない。原因を特定し、直してデプロイする(下記の凍結の例外) |
| inbox が 4xx を返している | そのフォロワーは失われた可能性が高い。`userAgent` と時刻からサーバーを特定し、個別に連絡する候補にする。原因は直してデプロイする(凍結の例外) |
| 特定のサーバーから誰も来ない(`ALL PENDING`) | そのサーバーで Move が捨てられた可能性(移行先の actor の取得が HTTP エラーになった、`UnavailableDomain` だった、Move に対応していない)。72時間待っても来なければ、個別に連絡する候補として一覧にする |
| 移行フォームで「not an alias」 | 何も実行されていない。手順6で `alsoKnownAs` を確かめて再試行する |
| 移行フォームで本人確認に失敗する | 何も実行されていない。パスワード / ユーザー名のどちらを求められているか確かめる |

**デプロイの凍結の例外。** 次をすべて満たすときだけ、凍結中でも修正を main にマージしてよい。

- inbox が 4xx / 5xx を返している、または Accept が送られていないなど、**今まさにフォロワーを失っている・失いうる**不具合である
- 修正が小さく、dev にデプロイして連合を確かめた([federation-testing.md](federation-testing.md))
- マージの直後に actor・WebFinger を数回 GET してウォームアップし、「4. 監視」を一通り行う

見た目の不具合や、移行と関係のない修正は凍結が解けるまで待つ。

**知らせ方。**

- Move の直後: 新アカウントから引っ越しの完了を投稿する(旧アカウントは Move の後は投稿できないので、予告は手順1で済ませる)
- 移らなかったフォロワー: 72時間後の突き合わせで `not_followed` に残った相手に、新アカウントからメンション(公開範囲はダイレクト)で、フォローし直してほしいと連絡する。
  連絡した相手と日時を #273 に記録する

## 6. 既知の制約

- **Bridgy Fed(`bsky.brid.gy`)経由の Bluesky のフォロワー**(6人、2026-10-10 時点)が Move に追従するかは未確認。リハーサルでは確かめられない。
  移行後に状態を見て、必要なら新アカウントで Bridgy Fed を有効にし直す。
- **Move に対応していないソフトウェアのフォロワーは移らない。**
- **リスト・ミュート・ブロック・お気に入りは移らない**(このプロジェクトに機能がない。→ Epic #10 のスコープ外)。
- **dev にも `Move` が届く。** dev の `@hakatashi@activitypub-dev.hakatashi.com` は旧アカウントをフォローしているため。こちらは `Move` を 2xx で受け取って捨てる(#260、[ADR-0115](../adr/0115-inbox-4xx-only-for-sender-faults.md))。
