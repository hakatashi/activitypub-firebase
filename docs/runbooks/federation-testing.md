# 連合(フェデレーション)の動作確認

連合の不具合はローカルでは再現しない。**実際に他のサーバーとやりとりして確認するしかない。**
この手順は dev 環境(`activitypub-dev.hakatashi.com`)を使う。

> このファイルは実際に確認を行うたびに書き足していくこと。

## 原則

- **本番(`hakatashi.com`)では試さない。** dev 環境を使う。
- **dev 環境は検証専用のデプロイ環境であり、検証のために既存データを破壊してよい。**
  PR を作成する前に、dev 環境が絡む変更は積極的にここに書かれた手順で確認すること
  (→ `AGENTS.md` の「検証」、dev へのデプロイ手順は `deploy-firebase` skill)。
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
| actor / WebFinger / nodeinfo | `curl` / `activitypub-testing`(認証不要) | 不要 |
| リモートから検索できる | `GET /api/v2/search?resolve=true` | 不要 |
| フォローと自動 Accept | `POST /api/v1/accounts/:id/follow` → `GET /api/v1/accounts/relationships` | 不要 |
| 投稿がタイムラインに届く | `POST /activitypub/createPost` → `GET /api/v1/timelines/home` | 不要 |
| プロフィール更新の反映 | Firestore REST で actor を書き換え → `publishProfileUpdate` → `GET /api/v1/accounts/:id` | 不要 |
| フォロー解除の処理 | `POST /api/v1/accounts/:id/unfollow` → followers コレクション | 不要 |
| Inbox Forwarding | `POST /api/v1/statuses`(`in_reply_to_id` 付き)→ `deliveries` | 不要 |
| Like / Announce の受信カウント | `POST /api/v1/statuses/:id/favourite`・`/reblog` → `objects` の `_meta` | 不要 |
| 他オリジンの `Delete`/`Update` 拒否 | 手で組んだ署名付きリクエストを inbox へ | **要**(署名を自分で作る) |
| 配送のリトライと記録 | `deliveries/resend` + `gcloud tasks list` + `gcloud logging read` | 不要 |
| テストアカウントとアクセストークンの発行 | `tootctl` + `rails runner` | 不要 |

**他オリジンからの `Delete`/`Update` の拒否を除き、手作業はゼロにできる。**
相手インスタンスを自前で持っている(→ [ADR-0014](../adr/0014-self-hosted-federation-test-instance.md))
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
(→ [ADR-0014](../adr/0014-self-hosted-federation-test-instance.md))。
**pawoo.net や mstdn.jp を検証に使わないこと。** pawoo.net は Phase 5 の引っ越し元であり、
テストでアカウントやドメインが制限されると引っ越し自体ができなくなる。

まだ構築していなければ、構築手順と現在の状態は `~/docs/mastodon-test-instance.md`(HakataMatrix 側)を参照。

`REMOTE` と `REMOTE_TOKEN`(~/docs/mastodon-test-instance.md の手順で発行したアクセストークン)は
リポジトリルートの `.env`(`.gitignore` 済み、git に残らない)に記録しておく運用にする。

```bash
# .env
REMOTE=https://mastodon-test.hakatashi.com
REMOTE_TOKEN=xxxxxxxx
```

```bash
set -a && source .env && set +a
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

### activitypub-testing による自動適合性チェック

Actor および各種コレクション (`inbox` / `outbox` / `followers` / `following` / `liked`) の AS2 応答構造と `OrderedCollection` 準拠性は、[`activitypub-testing`](https://codeberg.org/socialweb.coop/activitypub-testing) で一括検証できる(→ [ADR-0043](../adr/0043-smoke-test-dev-with-activitypub-testing.md))。dev への push デプロイ時にも CI のスモークテストジョブで自動実行される。

```bash
npx activitypub-testing test actor "$ACTOR"
```

確認すること:
- `passed` が 7 件出ること(Actor のプロパティ・GET 応答、および各コレクションの OrderedCollection / Collection 検証)
- `likes-collection-must-be-a-collection` / `shares-collection-must-be-a-collection` は Note 等のオブジェクト向けテストのため `inapplicable` で正常
- `outbox-post-*` は C2S POST に対するテストで未認可のため 403 (`cantTell`) で正常

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
# 匿名(Authorization なし)でコレクションを引く
curl -sH 'Accept: application/activity+json' "$ACTOR/followers" | jq '{totalItems}'
curl -sH 'Accept: application/activity+json' "$ACTOR/followers?page=true" \
  | jq '{count: (.orderedItems | length), next}'
```

- [ ] **匿名で** `orderedItems` が空でない(`Follow` は `to`/`cc` を持たないため
      `_meta.isPublic` を明示的に立てている。→ [ADR-0035](../adr/0035-mark-accepted-follow-as-public.md))
- [ ] フォロワーが `itemsPerPage` を超えるとき、`next` を辿って全ページ取得できる

`totalItems` だけ正しくて `orderedItems` が空になる不具合は過去に2度踏んでいる。
**必ず `?page=true` まで引くこと。**

**`requested: true` のまま止まる場合は `Accept` が配送されていない。**
「12. 配送の記録とリトライ」で `deliveries` を確認する。

同じ `Follow` を2回配送しても `Accept` が2回返らないこと(重複排除、
→ [ADR-0030](../adr/0030-inbox-redundant-delivery-detection.md))は「10. 重複配送の冪等性」で確認する。

## 5. 投稿が届くか

```bash
curl -X POST "$DEV/activitypub/createPost" \
  -H 'Content-Type: application/json' \
  -H "X-Hakatashi-Token: $HAKATASHI_TOKEN" \
  -d '{"text": "federation test '"$(date +%s)"'"}'

# 相手のホームタイムラインに出るか(配送は非同期なので少し待つ)
mapi "$REMOTE/api/v1/timelines/home?limit=5" | jq '.[] | {id, acct: .account.acct, content}'

# 相手側から見た投稿の ID(手順7・8で使う)と、dev 側の Note の IRI を控える
export STATUS_ID=$(mapi "$REMOTE/api/v1/timelines/home?limit=1" | jq -r '.[0].id')
export NOTE_ID=$(mapi "$REMOTE/api/v1/timelines/home?limit=1" | jq -r '.[0].uri')
```

- [ ] フォロワーのホームタイムラインに表示される
- [ ] `deliveries` に `status: "success"` の記録が残っている(手順12)

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

## 7. 返信とスレッドと Inbox Forwarding

自分の投稿への外部リプライは、フォロワーコレクションが宛先に含まれていれば
フォロワー全員へ転送しなければならない(W3C AP 7.1.2 の MUST)。
実装しないと「自分の返信だけが見えて相手の発言が見えない」状態になる。

転送は apex の `net/activity.js` の `forwardFromInbox` が行い、以下の3条件をすべて
満たしたときだけ走る。転送されないときはこの順に切り分ける。

1. 初回受信であること(`isNewActivity === true`。重複配送は転送しない)
2. `resolveThread` がローカル IRI のオブジェクトを解決できていること
3. `to`/`cc`/`audience` にこのサーバーの followers コレクションの IRI が含まれること

```bash
# 相手から dev の投稿へ返信する(STATUS_ID は手順5で控えた相手側の投稿 ID)
mapi -X POST "$REMOTE/api/v1/statuses" -d 'status=@hakatashi reply test' \
  -d "in_reply_to_id=$STATUS_ID" | jq '{id, uri}'

# 転送は Cloud Tasks 経由なので、フォロワー宛の配送記録で確認する
# (fsquery は「Firestore を直接読む」で定義する)
fsquery '{"structuredQuery":{"from":[{"collectionId":"deliveries"}],"limit":10}}' \
  | jq -c '.[].document.fields | {status: .status.stringValue, inbox: .inbox.stringValue}'
```

- [ ] 返信が dev の `inbox` に届き、`streams` に `Create` が保存される
- [ ] その返信が dev のフォロワー宛に転送される(`deliveries` にフォロワーの inbox が残る)
- [ ] 同じ返信を再配送しても転送が二重に走らない(条件1)

## 8. いいね・ブースト(Like / Announce)の受信

Mastodon の `Like` / `Announce` は `object` に**投稿(Note)の IRI** を指す。
apex は本来これを別のアクティビティとしてしか受理しないため、通常オブジェクトとしても
解決する変換を挟んでいる(→ [ADR-0038](../adr/0038-resolve-like-announce-object-as-plain-object.md))。
カウントは `objects` の `_meta.likesCount` / `_meta.sharesCount` に非正規化される
(→ [ADR-0037](../adr/0037-denormalize-like-announce-counts.md))。

```bash
# 相手から dev の投稿をふぁぼ・ブーストする
mapi -X POST "$REMOTE/api/v1/statuses/$STATUS_ID/favourite" | jq '{favourited}'
mapi -X POST "$REMOTE/api/v1/statuses/$STATUS_ID/reblog"    | jq '{reblogged}'

# 対象 Note のカウンタ(個別 GET は二重エンコードの罠があるので runQuery で引く。
# 「Firestore を直接読む」の注意書きを参照)
fsquery '{"structuredQuery":{"from":[{"collectionId":"objects"}],
  "where":{"fieldFilter":{"field":{"fieldPath":"type"},"op":"EQUAL",
  "value":{"stringValue":"Note"}}},"limit":5}}' \
  | jq -c '.[].document.fields._meta.mapValue.fields | {likesCount, sharesCount}'
```

- [ ] `Like` / `Announce` が 400 で拒否されず `streams` に保存される
- [ ] `_meta.likesCount` / `_meta.sharesCount` が増える
- [ ] `Undo` すると減る
- [ ] **いいねした側のリモートアクターの `statuses_count` が動かない**
      (`statuses_count` の非正規化は `Create` だけが対象。
      → [ADR-0039](../adr/0039-scope-statuses-count-to-create.md))

## 9. 他オリジンからの Delete / Update が拒否されるか

署名者のドメインと対象オブジェクトの `id` のドメインが一致しないアクティビティは
拒否しなければならない(MUST。→ [ADR-0031](../adr/0031-update-delete-same-origin-check.md))。
これが抜けていると、任意のサーバーが他人の投稿を消せる。

正規の Mastodon クライアントからは送れない。テスト用インスタンスの鍵で署名した
**別オリジンのオブジェクトを指す `Delete` / `Update`** を手で組んで dev の inbox に投げる
(署名鍵が要るので `mt bin/rails runner` から `ActivityPub` の配送を直接呼ぶか、
テスト用アカウントの秘密鍵を取り出して自分で署名する)。

- [ ] 他オリジンの `id` を対象にした `Delete` / `Update` が 403 で拒否される
- [ ] 拒否された対象オブジェクトが `objects` に残っている(消されていない)
- [ ] 同一オリジンの `Delete`(相手が自分の投稿を消す)は通り、Tombstone 化される

## 10. 重複配送の冪等性

Mastodon は再送を行うため、**同じアクティビティが複数回届くことが常にありうる。**
2回目以降は状態を変えてはならない(→ [ADR-0030](../adr/0030-inbox-redundant-delivery-detection.md))。

重複は意図的に起こしにくい(Mastodon は 2xx を返せば再送しない)。
**5xx を返すと Sidekiq が最大16回再送する**性質を使うか、相手側で
follow → unfollow → follow を素早く繰り返して同じ状態遷移を2度踏ませる。
過去には署名形式の異なる二重配送(draft-cavage と RFC 9421)で実際に起きた
(→ [ADR-0044](../adr/0044-self-implemented-http-signature-in-apex-fork.md))。

```bash
# 重複が起きたかどうかは、同一 id のアクティビティが1件しかないことで確認する
fsquery '{"structuredQuery":{"from":[{"collectionId":"streams"}],"limit":20}}' \
  | jq -r '.[].document.fields.id.stringValue' | sort | uniq -d
```

- [ ] 同じ `Follow` を2回受けても `Accept` は1回しか返らない
- [ ] `followers_count` / `likesCount` / `sharesCount` が二重にカウントされない
- [ ] `streams` に同じ `id` のアクティビティが2件できない

## 11. フォロー解除

```bash
mapi -X POST "$REMOTE/api/v1/accounts/$REMOTE_ACCOUNT_ID/unfollow" | jq '{following}'

curl -sH 'Accept: application/activity+json' "$ACTOR/followers" | jq '{totalItems}'
```

- [ ] `Undo` が処理されて followers から消え、`followers_count` が減る

## 12. 配送の記録とリトライ

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
REST API で読める(確認作業のみ。書き込みは手順6・12のような一時的なものに限る)。

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

**個別ドキュメントの GET/DELETE では `docid()` の出力をさらに URL エンコードすること。**
`docid()` は `escapeFirestoreKey` 相当(`.` → `%2E` など)を行うだけで、これを
そのまま URL パスに埋め込むと `%2E` がクライアント/サーバー側で1回デコードされて
`.` に戻り、**別の(存在しない)ドキュメントを指してしまう。** 個別 GET/DELETE は
存在しないドキュメントに対しても 200/404 を返すため気づきにくく、
`runQuery`(ボディで ID を渡すためこの問題が起きない)の結果と個別 GET の結果が
食い違う形で発覚する。

```bash
docid2() { node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$(docid "$1")"; }
curl -s -H "Authorization: Bearer $GCP_TOKEN" \
  "https://firestore.googleapis.com/v1/projects/activitypub-firebase-dev/databases/(default)/documents/streams/$(docid2 "$ACTIVITY_ID")"
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
| 投稿が届かない | 受信者解決(`deliveryEnqueue` のログに宛先が出ているか)、配送の失敗記録。`streams` の該当 Follow の `_meta.collection` が文字列でなく配列になっていないか(→ [ADR-0016](../adr/0016-fix-update-activity-meta-array-corruption.md)、修正済みだが過去データが残っている場合がある) |
| 配送が 401/403 で恒久失敗する | 署名鍵の不一致。リトライされず破棄される(`permanent_failure`)。本家 Mastodon 相手なら HTTP Signature の `keyId` に `#main-key` が付いているか(→ [ADR-0015](../adr/0015-fix-http-signature-keyid-fragment.md)、修正済み) |
| 署名検証エラー | `req.headers.host` の上書き(`activitypub.ts`)、`Digest` ヘッダ、鍵の不一致 |
| 変更が反映されない | リモートの actor キャッシュ。`publishProfileUpdate` を叩くか最大24時間待つ |
| 最初の1回だけ応答が返らない | Cloud Functions のコールドスタート。`-m 60` で叩き直す |
| コレクションが1ページしか返らない | 既知の不具合。[`known-issues.md`](../known-issues.md) を参照 |
| 相手が何を嫌がっているか分からない | テスト用インスタンスの `docker compose logs -f sidekiq` を読む |
| followers の `totalItems` と `followers_count` がずれる | 非正規化のずれ。`functions/bin/denormalizations.ts` で再計算する |

## テスト用インスタンス側の操作

自前ホストなので、相手側の状態もログも自由に見られる。これが既存の大規模インスタンスを
使わない最大の理由(→ [ADR-0014](../adr/0014-self-hosted-federation-test-instance.md))。

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

