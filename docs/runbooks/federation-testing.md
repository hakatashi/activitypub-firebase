# 連合(フェデレーション)の動作確認

連合の不具合はローカルでは再現しない。**実際に他のサーバーとやりとりして確認するしかない。**
この手順は dev 環境(`activitypub-dev.hakatashi.com`)を使う。

> このファイルは実際に確認を行うたびに書き足していくこと。

## 原則

- **本番(`hakatashi.com`)では試さない。** dev 環境を使う。
- **相手サーバーに対する操作は取り消せない。** フォロー・投稿は相手のログとキャッシュに残る。
  テスト用のアカウントを使うこと。
- リモートサーバーは actor をキャッシュする。**変更が反映されるまで最大24時間かかることがある。**
  「直したのに直らない」の多くはこれ。
- 配送は Cloud Tasks 経由の非同期処理なので、**相手側への反映は即座ではない。**
  数秒〜数十秒待ってから確認する。

## ツールだけでどこまで確認できるか

**GUI クライアント(Elk や Mastodon の Web UI)を開かなくても、ほぼすべて CLI で確認できる。**
相手側の操作は Mastodon REST API を curl で叩けばよく、こちら側の状態は管理者エンドポイントと
Firestore REST API で読める。

| 確認項目 | 手段 | 手作業 |
|---|---|---|
| actor / WebFinger / nodeinfo | `curl`(認証不要) | 不要 |
| リモートから検索できる | `GET /api/v2/search?resolve=true` | 不要 |
| フォローと自動 Accept | `POST /api/v1/accounts/:id/follow` → `GET /api/v1/accounts/relationships` | 不要 |
| 投稿がタイムラインに届く | `POST /activitypub/createPost` → `GET /api/v1/timelines/home` | 不要 |
| プロフィール更新の反映 | Firestore REST で actor を書き換え → `publishProfileUpdate` → `GET /api/v1/accounts/:id` | 不要 |
| フォロー解除の処理 | `POST /api/v1/accounts/:id/unfollow` → followers コレクション | 不要 |
| 配送のリトライと記録 | `deliveries/resend` + `gcloud tasks list` + `gcloud logging read` | 不要 |
| テストアカウントとアクセストークンの発行 | `tootctl` + `rails runner` | 不要 |

**手作業はゼロにできる。** 相手インスタンスを自前で持っている(→ [ADR-0013](../adr/0013-self-hosted-federation-test-instance.md))
ため、通常はブラウザでの OAuth 認可が必要なアクセストークンの発行も、管理者権限で
`rails runner` から直接できる(Mastodon 4.x の `grant_types_supported` は
`authorization_code` と `client_credentials` だけで、パスワードグラントがない。
`third_party/mastodon_documentation/content/en/methods/oauth.md`)。

「相手のクライアントで見えるか」は API の返り値(`relationship.following`、
home timeline に含まれるか、`account.display_name`)で等価に確認できる。
描画そのものの確認が必要なときだけ UI を開く。

## 0. 準備

```bash
# 管理者トークン(Secret Manager から取得する。画面やログに出さないこと)
export HAKATASHI_TOKEN=$(gcloud secrets versions access latest \
  --secret=HAKATASHI_TOKEN --project=activitypub-firebase-dev)

# Firestore REST API 用のアクセストークン(1時間で失効するので都度取り直す)
export GCP_TOKEN=$(gcloud auth print-access-token)

export DEV=https://activitypub-dev.hakatashi.com
export ACTOR=$DEV/activitypub/u/hakatashi
```

相手は自前ホストの `mastodon-test.hakatashi.com` を使う
(→ [ADR-0013](../adr/0013-self-hosted-federation-test-instance.md))。
**pawoo.net や mstdn.jp を検証に使わないこと。** pawoo.net は Phase 5 の引っ越し元であり、
テストでアカウントやドメインが制限されると引っ越し自体ができなくなる。

まだ構築していなければ「[付録: テスト用インスタンスの構築](#付録-テスト用インスタンスの構築)」を先に実施する。

```bash
export REMOTE=https://mastodon-test.hakatashi.com
export REMOTE_TOKEN=xxxxxxxx                 # 付録の手順で発行したアクセストークン
mapi() { curl -s -H "Authorization: Bearer $REMOTE_TOKEN" "$@"; }

# テスト用インスタンス側の操作(自宅サーバー上で実行する)
export MT=/opt/mastodon-test
mt() { (cd "$MT" && docker compose exec -T web "$@"); }
```

## 1. actor が正しく公開されているか

```bash
# WebFinger
curl -sH 'Accept: application/jrd+json' \
  "$DEV/.well-known/webfinger?resource=acct:hakatashi@activitypub-dev.hakatashi.com" | jq

# actor
curl -sH 'Accept: application/activity+json' "$ACTOR" | jq
```

確認すること:

- WebFinger の `subject` が**問い合わせた `resource` と一致している**こと。
  一致しないと Mastodon が2回目の WebFinger 要求を行う(→ [ADR-0008](../adr/0008-two-domain-split.md))
- `links` に `rel="self"` かつ `type` が `application/activity+json` または
  `application/ld+json; profile="https://www.w3.org/ns/activitystreams"` のものがあり、
  actor の IRI を指していること
- actor に `inbox` / `outbox` / `publicKey` / `preferredUsername` があること
- `preferredUsername` が `acct:` のユーザー名部分と一致すること
- **`application/ld+json; profile="..."` でも同じ内容が返ること**(仕様上こちらが MUST)

```bash
curl -sH 'Accept: application/ld+json; profile="https://www.w3.org/ns/activitystreams"' \
  "$ACTOR" | jq
```

> Cloud Functions のコールドスタートで初回だけ15秒以上かかることがある。
> タイムアウトしたら `curl -m 60` で叩き直す。落ちていると即断しない。

## 2. nodeinfo

```bash
curl -s "$DEV/.well-known/nodeinfo" | jq
curl -s "$DEV/nodeinfo/2.0" | jq
```

## 3. リモートから検索できるか

`resolve=true` を付けると、相手インスタンスが知らないアカウントでも WebFinger で解決を試みる
(ユーザートークンが必須)。これがリモートの検索窓に打ち込むのと同じ動作。

```bash
mapi "$REMOTE/api/v2/search?type=accounts&resolve=true&q=hakatashi@activitypub-dev.hakatashi.com" \
  | jq '.accounts[] | {id, acct, url, display_name}'

# 解決済みなら id を控える(以降で使う)
export REMOTE_ACCOUNT_ID=$(mapi "$REMOTE/api/v1/accounts/lookup?acct=hakatashi@activitypub-dev.hakatashi.com" | jq -r .id)
```

`accounts` が空なら、多くは WebFinger か actor のレスポンスの問題。
リモート側のサーバーログが見られないため、**手順1を先に完全に通しておくこと。**

## 4. フォローと自動 Accept

```bash
mapi -X POST "$REMOTE/api/v1/accounts/$REMOTE_ACCOUNT_ID/follow" | jq '{following, requested}'

# 数十秒待ってから
mapi "$REMOTE/api/v1/accounts/relationships?id[]=$REMOTE_ACCOUNT_ID" | jq '.[0] | {following, requested}'
```

- [ ] `requested: true` → `following: true` に変わる(`Accept` が届いている)
- [ ] followers コレクションに反映されている
- [ ] `streams` に `Follow` と `Accept` が記録されている
- [ ] `userInfos` の `followers_count` が増えている

```bash
curl -sH 'Accept: application/activity+json' "$ACTOR/followers" | jq '{totalItems}'
```

**`requested: true` のまま止まる場合は `Accept` が配送されていない。**
「9. 配送の記録とリトライ」で `deliveries` を確認する。

## 5. 投稿が届くか

```bash
curl -X POST "$DEV/activitypub/createPost" \
  -H 'Content-Type: application/json' \
  -H "X-Hakatashi-Token: $HAKATASHI_TOKEN" \
  -d '{"text": "federation test '"$(date +%s)"'"}'

# 相手のホームタイムラインに出るか(配送は非同期なので少し待つ)
mapi "$REMOTE/api/v1/timelines/home?limit=5" | jq '.[] | {acct: .account.acct, content}'
```

- [ ] フォロワーのホームタイムラインに表示される
- [ ] `deliveries` に `status: "success"` の記録が残っている(手順9)

## 6. プロフィール更新の配信

`PATCH /api/v1/accounts/update_credentials` は未実装なので、actor オブジェクトを
Firestore で直接書き換えてから配信する。apex は `name` / `summary` を**配列**で持つことに注意。

```bash
# Firestore のドキュメント ID は escapeFirestoreKey で % / . をエスケープしたもの
docid() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1].replaceAll(/%/g,"%25").replaceAll(/\//g,"%2F").replaceAll(/\./g,"%2E")))' "$1"; }

curl -s -X PATCH \
  -H "Authorization: Bearer $GCP_TOKEN" -H 'Content-Type: application/json' \
  "https://firestore.googleapis.com/v1/projects/activitypub-firebase-dev/databases/(default)/documents/objects/$(docid "$ACTOR")?updateMask.fieldPaths=name" \
  -d '{"fields":{"name":{"arrayValue":{"values":[{"stringValue":"hakatashi (dev, updated)"}]}}}}' | jq '.fields.name'

curl -sH "X-Hakatashi-Token: $HAKATASHI_TOKEN" "$DEV/activitypub/publishProfileUpdate"

# 相手側に反映されたか(Update が届けばキャッシュを待たずに変わる)
mapi "$REMOTE/api/v1/accounts/$REMOTE_ACCOUNT_ID" | jq '{display_name, note}'
```

- [ ] 相手側の表示名が更新される
- [ ] 確認後、元の値に戻す(同じ PATCH で書き戻す)

## 7. 返信とスレッド

- [ ] 相手から dev の投稿に返信し、`inbox` に届く
      (`mapi -X POST "$REMOTE/api/v1/statuses" -d 'status=...' -d "in_reply_to_id=..."`)
- [ ] Inbox Forwarding が動いていれば、その返信が dev のフォロワーにも転送される
      (未実装。Issue #7)

## 8. フォロー解除

```bash
mapi -X POST "$REMOTE/api/v1/accounts/$REMOTE_ACCOUNT_ID/unfollow" | jq '{following}'

curl -sH 'Accept: application/activity+json' "$ACTOR/followers" | jq '{totalItems}'
```

- [ ] `Undo` が処理されて followers から消え、`followers_count` が減る

## 9. 配送の記録とリトライ

配送結果は `deliveries` コレクションに記録される(→ [ADR-0012](../adr/0012-delivery-results-in-firestore.md))。

```bash
# 失敗中/リトライ中の配送
curl -sH "X-Hakatashi-Token: $HAKATASHI_TOKEN" "$DEV/activitypub/deliveries/failed" | jq

# キューに残っているタスク(リトライ待ちはここに見える)
gcloud tasks list --queue=deliveryTask --location=us-central1 \
  --project=activitypub-firebase-dev --format='value(name,scheduleTime,dispatchCount)'

# ワーカーのログ
gcloud logging read \
  'resource.labels.service_name="deliverytask" AND jsonPayload.type="deliveryTaskResult"' \
  --project=activitypub-firebase-dev --limit=20 --freshness=1h \
  --format='value(timestamp,jsonPayload.address,jsonPayload.statusCode)'
```

### 意図的に失敗させてリトライを確認する

存在しないホスト(`.invalid` TLD は必ず名前解決に失敗する)宛の配送記録を作り、
`deliveries/resend` で再送させる。**外部のサーバーには一切リクエストが飛ばない。**

```bash
ACTIVITY_ID="$DEV/activitypub/s/retry-test-$(date +%s)"
INBOX='https://nonexistent.invalid/inbox'
BODY=$(jq -cn --arg id "$ACTIVITY_ID" --arg actor "$ACTOR" \
  '{"@context":"https://www.w3.org/ns/activitystreams",id:$id,type:"Create",actor:$actor,object:{id:($id+"#o"),type:"Note",content:"retry test"}}')

curl -s -X POST -H "Authorization: Bearer $GCP_TOKEN" -H 'Content-Type: application/json' \
  "https://firestore.googleapis.com/v1/projects/activitypub-firebase-dev/databases/(default)/documents/deliveries?documentId=$(docid "$ACTIVITY_ID $INBOX")" \
  -d "$(jq -n --arg a "$ACTIVITY_ID" --arg actor "$ACTOR" --arg inbox "$INBOX" --arg body "$BODY" \
    '{fields:{activityId:{stringValue:$a},actorId:{stringValue:$actor},inbox:{stringValue:$inbox},body:{stringValue:$body},attempts:{integerValue:"0"},status:{stringValue:"retrying"},statusCode:{nullValue:null},error:{nullValue:null}}}')" | jq -r .name

curl -s -X POST "$DEV/activitypub/deliveries/resend" \
  -H 'Content-Type: application/json' -H "X-Hakatashi-Token: $HAKATASHI_TOKEN" \
  -d "{\"activityId\": \"$ACTIVITY_ID\", \"inbox\": \"$INBOX\"}"
```

- [ ] `deliveries/failed` の当該レコードの `attempts` が 1 → 2 → … と増える
      (`retryConfig` は `maxAttempts: 5`、バックオフ 10s から倍々なので3分ほどで打ち止め)
- [ ] `gcloud tasks list` にリトライ待ちのタスクが見える
- [ ] ログに `deliveryTaskReceived` が試行回数ぶん出る

**注意:** 試行を使い切っても `status` は `retrying` のまま残る(打ち止めを表す状態がない)。
`attempts` が `maxAttempts` に達していたら実質的な失敗と読む。
確認が終わったらテスト用のレコードは消しておく。

```bash
curl -s -X DELETE -H "Authorization: Bearer $GCP_TOKEN" \
  "https://firestore.googleapis.com/v1/projects/activitypub-firebase-dev/databases/(default)/documents/deliveries/$(docid "$ACTIVITY_ID $INBOX")"
```

## Firestore を直接読む

クライアントからの直接アクセスは禁止されているが、`gcloud` の認証情報を使えば
REST API で読める(確認作業のみ。書き込みは手順6・9のような一時的なものに限る)。

```bash
fsquery() {
  curl -s -X POST -H "Authorization: Bearer $GCP_TOKEN" -H 'Content-Type: application/json' \
    'https://firestore.googleapis.com/v1/projects/activitypub-firebase-dev/databases/(default)/documents:runQuery' -d "$1"
}

# userInfos(非正規化されたカウンタ)
fsquery '{"structuredQuery":{"from":[{"collectionId":"userInfos"}],"limit":3}}' \
  | jq '.[].document.fields | {followers_count, statuses_count}'

# 直近の streams(受信・送信したアクティビティ)
fsquery '{"structuredQuery":{"from":[{"collectionId":"streams"}],"limit":5}}' \
  | jq -c '.[].document.fields | {type: .type.stringValue, actor: .actor}'
```

## ログの確認

```bash
npm --prefix functions run logs
# または
firebase functions:log -P dev
# 条件を絞るなら
gcloud logging read 'resource.labels.service_name="activitypub" AND jsonPayload.type="inbox"' \
  --project=activitypub-firebase-dev --limit=20 --freshness=1h
```

現状は全リクエスト・全レスポンスが `info` で出力されているため量が多い。
`type` フィールド(`request` / `response` / `inbox` / `outbox` / `deliveryEnqueue` /
`deliveryTaskReceived` / `deliveryTaskResult` / `recordDeliveryResult` など)で絞る。

## トラブルシューティング

| 症状 | 疑うところ |
|---|---|
| 検索しても見つからない | WebFinger の `subject` と `links[rel=self]` |
| フォローが「リクエスト中」で止まる | `Accept` の配送。`deliveries/failed` と `deliveryTask` のログ |
| 投稿が届かない | 受信者解決(`deliveryEnqueue` のログに宛先が出ているか)、配送の失敗記録 |
| 配送が 401/403 で恒久失敗する | 署名鍵の不一致。リトライされず破棄される(`permanent_failure`) |
| 署名検証エラー | `req.headers.host` の上書き(`activitypub.ts`)、`Digest` ヘッダ、鍵の不一致 |
| 変更が反映されない | リモートの actor キャッシュ。`publishProfileUpdate` を叩くか最大24時間待つ |
| 最初の1回だけ応答が返らない | Cloud Functions のコールドスタート。`-m 60` で叩き直す |
| コレクションが1ページしか返らない | 既知の不具合。[`known-issues.md`](../known-issues.md) を参照 |
| 相手が何を嫌がっているか分からない | テスト用インスタンスの `docker compose logs -f sidekiq` を読む |
| followers の `totalItems` と `followers_count` がずれる | 非正規化のずれ。`functions/bin/denormalizations.ts` で再計算する |

## テスト用インスタンス側の操作

自前ホストなので、相手側の状態もログも自由に見られる。これが既存の大規模インスタンスを
使わない最大の理由(→ [ADR-0013](../adr/0013-self-hosted-federation-test-instance.md))。

```bash
# 相手側のログ。署名検証の失敗理由はここに出る
(cd $MT && docker compose logs -f sidekiq | grep -i activitypub-dev)
(cd $MT && docker compose logs -f web)

# dev ドメインの痕跡を完全に消す。「初対面」からやり直したいとき
mt bin/tootctl domains purge activitypub-dev.hakatashi.com

# actor だけ取り直す(キャッシュ24時間を待たない)
mt bin/tootctl accounts refresh --domain activitypub-dev.hakatashi.com

# メディアキャッシュの掃除(ディスクに余裕がないので定期的に)
mt bin/tootctl media remove --days 1
```

**`domains purge` はフォロー関係も投稿も消える。** 手順4以降をやり直すことになる。

## 付録: テスト用インスタンスの構築

`mastodon-test.hakatashi.com` を自宅サーバー(HakataMatrix)に立てる手順。
初回のみ。**このサーバーの現状を確認した上で書いている。**

前提(確認済み):

- Docker 29.4 / Compose v5.1、`hakatashi` は `docker` グループに所属している
- nginx(host、1.24.0)+ certbot が 80/443 を持ち、`*.matrix.hakatashi.com` の
  vhost が同居している。Mastodon もこの nginx に相乗りする
- ポート 3000 / 4000 は空いている
- ディスクは残り約 73GB(92% 使用)。メディアキャッシュを放置しないこと
- `hakatashi.com` の公開 DNS は Cloudflare(`marek/fiona.ns.cloudflare.com`)。
  `*.hakatashi.com` のワイルドカードは別ホスト(104.131.49.125)を指しているため、
  **`mastodon-test` の A レコードを明示的に追加する必要がある**

### 1. DNS

Cloudflare の `hakatashi.com` ゾーンに A レコードを追加する。
**Proxy status は DNS only(グレークラウド)にする** — 既存の自宅サーバー向けレコードと同じ扱い。

| Type | Name | Content |
|---|---|---|
| A | `mastodon-test` | `60.81.69.135`(自宅の公開 IP。`dig @8.8.8.8 matrix.hakatashi.com +short` で確認できる) |

```bash
dig @1.1.1.1 mastodon-test.hakatashi.com +short   # 60.81.69.135 になるまで待つ
```

### 2. 配置

```bash
sudo mkdir -p /opt/mastodon-test && sudo chown "$USER" /opt/mastodon-test
cd /opt/mastodon-test
cp ~/Documents/GitHub/activitypub-firebase/third_party/mastodon/docker-compose.yml .
mkdir -p public/system postgres14 redis
sudo chown -R 991:991 public/system    # コンテナ内の mastodon ユーザーは UID/GID 991
touch .env.production
```

`docker-compose.yml` は submodule のものをそのまま使う(`ghcr.io/mastodon/mastodon:v4.7.1` を
参照している)。`web` は `127.0.0.1:3000`、`streaming` は `127.0.0.1:4000` にだけ bind される。

### 3. 初期設定ウィザード

```bash
docker compose run --rm web bundle exec rake mastodon:setup
```

答える内容:

| 質問 | 答え |
|---|---|
| Domain name | `mastodon-test.hakatashi.com` |
| Single user mode | No |
| Are you using Docker to run Mastodon? | **Yes**(以降の DB / Redis のデフォルトが `db` / `redis` になる) |
| PostgreSQL host / port / db / user / password | すべてデフォルト(`db` / `5432` / `postgres` / `postgres` / 空) |
| Redis host / port / password | すべてデフォルト(`redis` / `6379` / 空) |
| Do you want to store uploaded files on the cloud? | No |
| E-mail | localhost からの送信でよい。**テストメールの送信は No** |
| Save configuration? | Yes |
| Prepare the database now? | Yes |
| Do you want to create an admin user straight away? | Yes(あとで `tootctl` でも作れる) |

**Docker で実行した場合、ウィザードは設定内容を標準出力に印字する
(`Below is your configuration, save it to an .env.production file outside Docker:`)。
これをホスト側の `/opt/mastodon-test/.env.production` に貼り付けて保存する。**
コンテナ内に書かれた `.env.production` は `--rm` で消えるため、これを忘れると起動できない。

### 4. 起動と nginx

```bash
docker compose up -d
curl -s localhost:3000/health          # => OK
```

`/etc/nginx/sites-available/mastodon-test.hakatashi.com` を作る。
既存の vhost(`immich.matrix.hakatashi.com` など)と同じ書き方に合わせ、
streaming だけ 4000 に振り分ける(公式テンプレートは
`third_party/mastodon/dist/nginx.conf`)。

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name mastodon-test.hakatashi.com;

    client_max_body_size 99m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
    }

    location ^~ /api/v1/streaming {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }

    location ~ /.well-known/acme-challenge { allow all; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mastodon-test.hakatashi.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d mastodon-test.hakatashi.com   # 443 と HTTP→HTTPS リダイレクトを追記させる
curl -s https://mastodon-test.hakatashi.com/api/v1/instance | jq .version
```

### 5. アカウントとアクセストークン

```bash
cd /opt/mastodon-test

# 管理者アカウント(メール確認をスキップして作る。生成されたパスワードが表示される)
docker compose exec -T web bin/tootctl accounts create fedtest \
  --email fedtest@hakatashi.com --confirmed --approve --role Owner

# アクセストークンをブラウザなしで発行する
docker compose exec -T web bin/rails runner '
  user  = User.find_by!(email: "fedtest@hakatashi.com")
  app   = Doorkeeper::Application.create!(
    name: "federation-testing",
    redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
    scopes: "read write follow")
  token = Doorkeeper::AccessToken.create!(
    application: app, resource_owner_id: user.id, scopes: app.scopes,
    expires_in: nil, use_refresh_token: false)
  puts token.token
'
```

出力されたトークンを `REMOTE_TOKEN` に入れれば、手順3以降がすべて CLI で回せる。
**このトークンはパスワードと同等。** ログや git に残さないこと。

### 停止・撤去

```bash
cd /opt/mastodon-test
docker compose down          # 停止(データは残る)
docker compose down -v       # ボリュームごと破棄
```
