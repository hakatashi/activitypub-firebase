# アカウントの引っ越し(pawoo.net → hakatashi.com)

`@hakatashi@pawoo.net` から `@hakatashi@hakatashi.com` へ引っ越す手順(Epic [#10](https://github.com/hakatashi/activitypub-firebase/issues/10))。
リハーサル(#272)と本番(#273)の両方でこの手順書どおりに実行した。本番は 2026-10-17 15:43:45Z に Move を実行し、
本番で起きたことは各手順に書き足したうえで「7. 本番の記録」にまとめてある。もう一度引っ越すときも、この手順書を土台にする。

**引っ越しはやり直せない。** 当日に判断を迷わないよう、判断の基準はすべてここに書く。ここにない判断が必要になったら、手を止めて Issue に書く。

リハーサルでは次のとおり読み替える。

| 本番 | リハーサル |
|---|---|
| 旧アカウント `hakatashi@pawoo.net` | 検証用 Mastodon(`mastodon-test.hakatashi.com`)/ 検証用 Misskey の旧アカウント |
| `activitypub-firebase` / `hakatashi.com` | `activitypub-firebase-dev` / `activitypub-dev.hakatashi.com` |
| `functions/.env` の変更を main にマージ | `gcloud run services update ... --min-instances=1`(→ [federation-testing.md](federation-testing.md) の 13) |
| `~/migration/` | `~/migration-rehearsal/`(本番の記録と混ぜない) |
| pawoo.net の Web 画面から CSV を書き出す | mastodon-test の `bin/rails runner` で `Export.new(account).to_following_accounts_csv` / `to_bookmarks_csv` |
| `migrationStatus.ts --account=...`(旧アカウントが Mastodon) | 旧アカウントが Misskey のときは `--account` が使えない(Mastodon API でしか取得しない)。Misskey の `users/followers` から `[{id, username, acct, url}]` の JSON を作って `--file` で渡す |
| 移行フォームの本人確認(現在のユーザー名) | テストアカウントにはパスワードがあるので、パスワードを求められる。ユーザー名の入力欄は本番の前日に pawoo.net で確かめる |

リハーサルだけの事情(2026-10-13 のリハーサルで判明):

- **ローカルのスクリプトには `ALLOW_PRIVATE_NETWORK=true` を付ける。** HakataMatrix から見ると検証用インスタンスは LAN のアドレス(192.168.10.112)に解決され、
  SSRF ガードで止まる(`importFollowing.ts` の WebFinger、`migrationStatus.ts` の解決など)。本番の相手は公開サーバーなので付けない。
- HakataMatrix の `/etc/hosts` で `misskey-test.hakatashi.com` が 127.0.0.1 を向いているため、ループバックは許可されず、
  手順7の事前配送で misskey-test が `Unresolved Domains` に出る。Misskey は `Move` を受けると移行先の actor を取り直す
  (`ApPersonService#updatePerson`)ので、移行には影響しない。
- 検証用 Mastodon と検証用 Misskey の間の連合には、互いのプライベートアドレスの許可が要る
  (mastodon-test の `extra_hosts` と `ALLOWED_PRIVATE_ADDRESSES`、misskey-test の `allowedPrivateNetworks`。2026-10-13 に設定済み)。
- `rails runner` で作ったテストアカウントは `user.update_column(:approved, true)` まで行う。承認待ちのままだと actor が 404 になり、インポートで `Unresolvable` になる。
- Mastodon は一度もログインしていないユーザーのホームのフィードに書き込まないので、移ってきたフォロワーのタイムラインに投稿が届いたかは、
  `FeedManager.instance.populate_home(account)` の後に `HomeFeed#get` で見る(投稿が相手のサーバーに届いていることは `Status` で確かめる)。
- 移行フォームの送信は Playwright で行ってよい(パスワードを `rails runner` で設定する)。

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

## 2. 前提条件のチェックリスト(Go / No-Go)

**1つでも満たさなければ、Move を実行しない(No-Go)。**

- [ ] Epic #10 の事前点検の Issue(#258 #259 #260 #261 #262 #263 #271 と、それらから派生した Issue)がすべて閉じている
- [ ] リハーサル(#272)で、3つの経路のすべてでフォロワーが全員移ってきた(移らなかった相手は原因が説明できる)
- [ ] 本番の点検([production-preflight-check.md](production-preflight-check.md))を、**実行の前日以内に**もう一度行い、判定の基準をすべて満たす。特に:
  - 直近の main の run で `Deploy to Firebase except for Hosting` が `success`(main のコードが本番に入っている)
  - inbox の 4xx がない(あれば1件ずつ説明がつく)
  - `reconcilePendingFollows.ts --dry-run` の `pendingFollows` が空
  - `deliveries/failed` に Accept の失敗(`retrying` / `permanent_failure`)が残っていない。
    相手側でこちらへのフォローがリクエスト中のまま止まっていると、Move を受けても Follow は送り直されない(「6. 既知の制約」)
  - `checkActorKeyPair.ts` が `matches: true`
  - WebFinger が1段で解決し、actor に `alsoKnownAs` が出ている(手順3の後)
- [ ] `activitypub` Function の最小インスタンス数が本番で 1 になっている(手順2。→ [ADR-0113](../adr/0113-temporary-min-instances-during-migration.md)、[ADR-0116](../adr/0116-dotenv-for-functions-params.md))
  ```bash
  gcloud functions describe activitypub --region=asia-northeast1 --project=activitypub-firebase \
    --format='value(serviceConfig.minInstanceCount)'   # → 1(0 のときは空になる)
  ```
- [ ] **デプロイの凍結を宣言した。** Move の前日から3日後までは main にマージしない。main への push は本番に自動デプロイされ、全インスタンスが入れ替わる(例外は「5. 問題が起きたときの対処」)
- [ ] 移行の前後でローカル actor の鍵をローテーションしない(`functions/bin/rotateActorKey.ts`、[ADR-0009](../adr/0009-rotate-actor-key-now.md))。Move を処理するサーバーが鍵をキャッシュしている
- [ ] 旧アカウントで、移行フォームの本人確認を通れることを確かめた。
  pawoo.net の `@hakatashi` は pixiv の OAuth 連携でログインしており、パスワードがない。
  Mastodon 4.1.18 の移行フォームは、パスワードが設定されていなければ**現在のユーザー名**(`hakatashi`)の入力を求める(`AccountMigration#save_with_challenge`)。
  フォームを開いて入力欄が「現在のユーザー名」になっていることだけを確かめ、送信しない。
  (2026-10-15 に pawoo.net で開いたときは本人確認の入力欄が表示されなかったが、10/17 の送信は一度で成功した。
  エラーが出ても、本人確認で弾かれた場合は何も実行されていない)
- [ ] 旧アカウントのフォロー(`following_accounts.csv`)とブックマーク(`bookmarks.csv`)の CSV を保存した(pawoo.net の「設定 > インポート・エクスポート > データのエクスポート」)
- [ ] 旧アカウントのフォロワー一覧を保存した(手順4。Move の後は旧アカウントのフォロワーが減っていくので、**Move の前に**保存したものを基準にする)
- [ ] **旧サーバーの応答を計測し、actor の取得と移行フォームが安定して 10 秒未満で返る**(手順9。方法と基準は下記)。
  旧サーバーのローカルのフォロワーの移行(旧サーバーの Sidekiq が Follow を送る)、こちらの署名の検証(旧サーバーから actor を取る)、
  `Accept` の配送(旧サーバーの inbox)が、どれも旧サーバーの応答に依存するため。
  2026-10-16・17 朝は pawoo.net の actor の取得の半分以上がタイムアウトし、移行フォームも 504 になったので延期した
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
   フォローした相手から新アカウントがフォローバックされても、引っ越しは妨げられない。旧アカウントのフォロワーが移行先をすでにフォローしていれば、
   Move を受けたサーバーは Follow を送らずに済ませる(Mastodon の `FollowService#call` は `following?` なら `change_follow_options!` だけを行う。
   Misskey は `already following` で終わる)。そのフォロワーは手順8の時点で `followed` と数えられる。

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
   前回の点検から日が空いたら、preflight を取り直し、旧アカウントのフォロワー数が変わっていれば手順5と手順8を取り直す。

   **旧サーバーの応答の計測。** 次の4つのエンドポイントを、各 60 秒でタイムアウトさせて巡回し、応答時間を記録する
   (`curl -s -o /dev/null -m 60 -w '%{http_code} %{time_total}\n'`)。
   まず 20 秒おきに 8 巡、良さそうなら 1 分おきに 30 巡を、Move の直前まで続ける。

   | エンドポイント | 備考 |
   |---|---|
   | actor `https://pawoo.net/users/hakatashi`(`Accept: application/activity+json`) | 署名の検証で、相手のサーバーが取りに来るもの |
   | `https://pawoo.net/api/v1/accounts/lookup?acct=hakatashi` | |
   | 移行フォーム `https://pawoo.net/settings/migration` | 未ログインなので 302 |
   | プロフィール `https://pawoo.net/@hakatashi` | |

   - **Go の基準:** 60 秒のタイムアウトと 30 秒前後の応答がなく、actor の取得と移行フォームが**安定して 10 秒未満**で返る。
     満たさなければ延期する(延期しても失うものはない。別名は無害で、事前配送の効果は数日なら残る)。
   - 10 秒未満でも、こちらの `requestTimeout`(5 秒)を超える応答が混じるなら、Move の直後に署名の検証の一部が失敗し、
     inbox が旧サーバーに 5xx を返すことを見込んでおく(「5. 問題が起きたときの対処」)。
     2026-10-17 は actor の取得が 2〜6 秒中心(最大 7.7 秒)の状態で Go とした。
   - 張り付いて監視できる時間から逆算して Move の期限を決め、それまでに基準を満たさなければ延期する。
10. **Move を実行する。** pawoo.net の「設定 > アカウント > 別のアカウントへの引っ越し」で、
    引っ越し先に `hakatashi@hakatashi.com`、本人確認に現在のユーザー名を入力して送信する。
    - エラー「not an alias of this account」(この引っ越し先は別名に含まれていない)が出た場合、**このエラーでは何も実行されていない。**
      手順6のコマンドで `alsoKnownAs` を確かめ、直してから再試行してよい。
    - 送信がエラー(504 など)になったら、**もう一度送信する前に**、旧アカウントの `moved` / `movedTo` とこちらの inbox に `Move` が届いたかを見て、実行されたかを確かめる。
    - 送信が成功した時刻を記録する。
11. 監視する(「4. 監視」)。

### 3.4. 落ち着いてから

12. **後片付け。**
    - 最小インスタンス数を戻すか判断する。Move から1週間(各サーバーの `PROCESSING_COOLDOWN`)経って、新しい Follow が来なくなったら `ACTIVITYPUB_MIN_INSTANCES=0` に戻す PR をマージする
    - デプロイの凍結を解く
    - 移らなかったフォロワーの内訳と対応を #273 に記録する

## 4. 監視

Move の実行直後・1時間後・24時間後・72時間後に、次をすべて行う。

**進捗の突き合わせ。** サーバーごとに、移ってきたフォロワーの数を見る。
`[ALL PENDING - Move not processed?]` が付いたサーバーは、そのサーバーで Move が捨てられた可能性がある。
途中に出る JSON の WARNING は、まだ移ってきていないフォロワーの WebFinger を引けなかったことを示す。種類によって扱いが違う。

- `ssrfBlockedUnresolvable` / `Could not resolve hostname`: **サーバーが消えている**(DNS で引けない)。そのフォロワーは移ってこないので、移らなかった人数から除いて数える。
  2026-10-13 の時点で 13 ドメイン・15 人が該当(3.nu、compassion.online、kabutodon.com、lucida-don.net、m6n.jp、mangadon.net、masutabedon.com、
  med-mstdn.com、meisskey.blue、mstdn.engrowth.com、mstdn.umiu.si、social.hideo54.com、zoudon.jp)
- `webfingerErrorResponse` の 404 / 410: サーバーはあるがアカウントが消えている(同時点で friends.nico の 8 人など 10 人)。これも除いて数える
- 接続のタイムアウト・証明書のエラーなど: サーバーは残っているが今は応答しない(同時点で mstdn.poyo.me、mastodon.nara.jp など)。
  一時的な障害の可能性があるので除かず、72時間後も残れば個別に連絡する候補にする

WARNING とは別に、次のフォロワーは移ってくるかどうかが移行の成否と関係ないので、移れるはずのフォロワーの人数から除いて数える。

- **自分の actor 2人**(`activitypub-dev.hakatashi.com` と `hakatashi.com`)。どちらも旧アカウントをフォローしているので一覧に入るが、
  `Move` を 2xx で受け取って捨てる(「6. 既知の制約」)ので `not_followed`(`ALL PENDING`)のまま残る。
- **旧サーバーで凍結されたアカウント**(actor が 410)。旧サーバーは凍結されたアカウントのフォローを移さず、こちらも署名者を取れない(2026-10-17 は pawoo.net の1人)。
- **検証用インスタンス**(`mastodon-test.hakatashi.com`)のアカウント。移ってくるが、本番のフォロワーではない。

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

移ってきたかどうかは、この突き合わせ(こちらの射影)で判断する。**Misskey 側の `users/relation` の `isFollowing` は使えない。**
Misskey は相手がロックしていなければ、Follow を送った時点で自分の側のフォローを作るので、こちらに Follow が届いていなくても `true` になる。

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
| inbox が 5xx を返している | 相手は再送してくるので、慌てない。原因を特定し、直してデプロイする(下記の凍結の例外)。2026-10-13 のリハーサルでは、inbox が18分間 503 を返す最中に Move しても、復旧後に全員が移ってきた(Mastodon は復旧から約10分、Misskey は約30分以内) |
| 旧サーバーのフォロワーの Follow に inbox が 500(`Headers Timeout Error` / `TransientFetchError`) | 旧サーバーが遅く、actor をキャッシュしていないフォロワーの署名者の取得が `requestTimeout`(5 秒)を超えている。**相手の再送で回収できるので、何もしない。** 2026-10-17 は Move の直後に pawoo.net へ 500 を 84 件返したが、約1時間で全員が移ってきた(→ [#326](https://github.com/hakatashi/activitypub-firebase/issues/326)) |
| Follow に inbox が 503(`Dereferencing a URL did not result in a valid JSON-LD object`) | `@context` に `https://w3id.org/identity/v1` が入っている(GoToSocial 系)。#325 を直すまでは取得できずに 503 が続く。本番の Firestore の `contexts` には 2026-10-17 に Misskey が同梱しているもの(`third_party/misskey/packages/backend/src/core/activitypub/misc/contexts.ts` の `id_v1`)を手で入れてあるので、本番では起きないはず。別の context で同じことが起きたら、ユーザーの承認を得て同じ形式(`Store#saveContext`)で入れる(→ [#325](https://github.com/hakatashi/activitypub-firebase/issues/325)) |
| フォロワーではない相手の `Block` に inbox が 500 | 旧アカウントをブロックしていた人のブロックが、Mastodon の Move の処理で移行先に引き継がれて届いている。署名者が取れない(相手が 401 を返す、旧サーバーで削除・凍結済みで 410)と 500 になる。フォロワーではないので、引っ越しには影響しない(→ [#327](https://github.com/hakatashi/activitypub-firebase/issues/327)) |
| inbox が 4xx を返している | そのフォロワーは失われた可能性が高い。`userAgent` と時刻からサーバーを特定し、個別に連絡する候補にする。原因は直してデプロイする(凍結の例外) |
| 特定のサーバーから誰も来ない(`ALL PENDING`) | そのサーバーで Move が捨てられた可能性(移行先の actor の取得が HTTP エラーになった、`UnavailableDomain` だった、Move に対応していない)。72時間待っても来なければ、個別に連絡する候補として一覧にする |
| 移行フォームで「not an alias」 | 何も実行されていない。手順6で `alsoKnownAs` を確かめて再試行する |
| 移行フォームで本人確認に失敗する | 何も実行されていない。パスワード / ユーザー名のどちらを求められているか確かめる |

**デプロイの凍結の例外。** 次をすべて満たすときだけ、凍結中でも修正を main にマージしてよい。

- inbox が 4xx / 5xx を返している、または Accept が送られていないなど、**今まさにフォロワーを失っている・失いうる**不具合である
- 修正が小さく、dev にデプロイして連合を確かめた([federation-testing.md](federation-testing.md))
- マージの直後に actor・WebFinger を数回 GET してウォームアップし、「4. 監視」を一通り行う

修正を dev で確かめるときは、`gcloud` で最小インスタンス数を 1 にしてある dev に `firebase deploy` すると、
`functions/.env` の `ACTIVITYPUB_MIN_INSTANCES=0` で最小インスタンス数が 0 に戻る。作業ツリーに
`functions/.env.activitypub-firebase-dev`(gitignore 済み)を置いて `ACTIVITYPUB_MIN_INSTANCES=1` を書き、
`firebase deploy --only functions:activitypub -P activitypub-firebase-dev --force` でデプロイする
(`--force` は最小インスタンス数による料金の増加の確認を飛ばすため。`--only` で対象を絞っているので他の Function は消えない)。

見た目の不具合や、移行と関係のない修正は凍結が解けるまで待つ。

**知らせ方。**

- Move の直後: 新アカウントから引っ越しの完了を投稿する(旧アカウントは Move の後は投稿できないので、予告は手順1で済ませる)。
  **投稿の配送が、旧サーバーの不調で尽きることがある。** 1時間ほど後に `deliveries/failed`(「4. 監視」)で旧サーバーの sharedInbox への `Create` を探し、
  残っていれば `deliveries/resend` で再送する(2026-10-17 は pawoo.net への5回の試行がすべて `Headers Timeout Error` で、翌日の再送で届いた)
- 移らなかったフォロワー: 72時間後の突き合わせで `not_followed` に残った相手に、新アカウントからメンション(公開範囲はダイレクト)で、フォローし直してほしいと連絡する。
  連絡した相手と日時を #273 に記録する

## 6. 既知の制約

- **Bridgy Fed(`bsky.brid.gy`)経由の Bluesky のフォロワーは Move に追従しない。** 2026-10-17 は6人のうち5人が移らなかった。
  必要なら新アカウントで Bridgy Fed を有効にし直す。
- **旧サーバーをブロックしているサーバーのフォロワーは移らない。** Move がそもそも届かない。misskey.io は pawoo.net をブロック・凍結している
  (`federation/show-instance` の `isBlocked` / `isSuspended`)ので、misskey.io の 18 人は Move の前から新アカウントをフォローしていた1人を除いて移らなかった。
  個別に連絡する対象として、ほかの「移らなかった」とは分けて数える。
- **Move に対応していないソフトウェアのフォロワーは移らない。**
- **相手側で新アカウントへのフォローがリクエスト中のまま止まっているフォロワーは移らない。** Mastodon の `FollowService#call` は、
  `requested?` なら `change_follow_request_options!` だけを行い、Follow を送り直さない。こちらに Follow が届いていない場合は
  `migrationStatus.ts` には `not_followed` としか出ず、区別できない。Accept の失敗による停滞は、チェックリストの `deliveries/failed` で Move の前に潰す。
- **リスト・ミュート・ブロック・お気に入りは移らない**(→ Epic #10 のスコープ外)。リストはエクスポートした `lists.csv` を
  `functions/bin/importLists.ts` で取り込める([ADR-0134](../adr/0134-lists-stored-per-user-and-filtered-on-read.md))。ほかはこのプロジェクトに機能がない。
- **自分の actor にも `Move` が届く。** dev の `@hakatashi@activitypub-dev.hakatashi.com` と本番の `@hakatashi@hakatashi.com` は、どちらも旧アカウントをフォローしているため。
  こちらは `Move` を 2xx で受け取って捨てる(#260、[ADR-0115](../adr/0115-inbox-4xx-only-for-sender-faults.md))。
- **旧アカウントへのブロックは移行先に引き継がれる。** Mastodon は Move を受けると、旧アカウントをブロックしていた人のブロックを移行先にも作り、`Block` が届く(「5. 問題が起きたときの対処」)。

## 7. 本番の記録(2026-10-17)

詳細は [#273](https://github.com/hakatashi/activitypub-firebase/issues/273) のコメントにある。時刻は UTC。

- 10/16 と 10/17 朝は Go / No-Go の他の項目をすべて満たしていたが、pawoo.net の応答が遅く(actor の取得の半分以上が 60 秒でタイムアウト、移行フォームが 504)延期した。
  10/17 13:47Z から計測し直し、15:36Z に基準を満たしたので Go とし、15:43:45Z に Move を実行した。
- フォロワーの移行は Move から約1時間でほぼ終わり、24 時間後・72 時間後には変化がなかった。

| 72 時間後の内訳 | 人数 |
|---|---|
| 旧アカウントのフォロワー | 216 |
| 除いて数える: 消えたサーバー(DNS で引けない、13 ドメイン) | 15 |
| 除いて数える: 消えたアカウント(friends.nico 8、mstdn-workers.com 1)・サービスを終えたサーバー(qiitadon.com 1) | 10 |
| 除いて数える: 旧サーバーで凍結されたアカウント | 1 |
| 除いて数える: 自分の actor 2人と検証用インスタンス | 3 |
| **移れるはずのフォロワー** | **187** |
| **移った** | **152(81%)** |
| 移らなかった: 旧サーバーをブロックしている(misskey.io) | 17 |
| 移らなかった: そのほか(bsky.brid.gy 5、Move の時点で応答していなかった mstdn.poyo.me 3、証明書のエラー 4 など) | 18 |

- 引っ越しの Follow に inbox が 4xx を返したことは一度もなく、承認漏れ・Accept の配送の失敗も 0 だった。
- 起きた問題と対処は「5. 問題が起きたときの対処」の表に書き足した(署名者の取得のタイムアウト、identity/v1 の 503、`Block` の 500、引っ越しのお知らせの配送の失敗)。
