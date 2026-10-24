# ボット用インスタンスの運用

ボット用インスタンス `bots.activitypub.hakatashi.com`(Firebase プロジェクト `activitypub-firebase-bots`)で、
ボットを作り、外部のプログラムから投稿させる手順。設計は ADR-0148〜0152 にある。
dev(`activitypub-dev.hakatashi.com`)でもボット機能は有効なので、同じ手順で検証できる。

## 前提

- 管理用の秘密値は Secret Manager の `HAKATASHI_TOKEN`(プロジェクトごとに別の値)。
  手元ではリポジトリルートの `.env`(gitignore 済み)に、ボット用インスタンスの値を `BOTS_HAKATASHI_TOKEN` として置いている。
  **値を画面・ログ・PR・コミットに出さない。**
- `functions/src/instanceConfig.ts` の対応表が、ドメインとボット機能の有無と既定の許可リストを決める。

```bash
set -a; . ./.env; set +a
H=https://bots.activitypub.hakatashi.com
```

## ボットを作る

```bash
curl -s -X POST -H "x-hakatashi-token: $BOTS_HAKATASHI_TOKEN" -H 'Content-Type: application/json' \
  $H/activitypub/bots -d '{"username":"weather","displayName":"天気","summary":"天気予報を投稿します。"}'
```

- `username` は `^[a-z0-9_]{1,30}$`。すでにある名前は 409(鍵は上書きされない)。
- `followPolicy` を省くと `allowlist` になり、許可リストは本番と dev の `hakatashi` になる。
  投稿の既定の公開範囲は `private`(フォロワー限定)。
- Fediverse 全体に公開するボットは `"followPolicy":{"mode":"open"}` を付ける(既定の公開範囲は `public`)。
- 一覧は `GET $H/activitypub/bots`。ポリシーの変更は
  `PATCH $H/activitypub/bots/<username>`(本文は `{"followPolicy":{...}}`)。
- アイコンや表示名は、下のオペレータートークンで `PATCH /api/v1/accounts/update_credentials` を呼んで変える。

## オペレータートークン

すべてのボットを1つのトークンで操作する(→ ADR-0151)。

```bash
# 発行(値は応答で1度だけ返る。外部のプログラムの秘密の設定に入れる)
curl -s -X POST -H "x-hakatashi-token: $BOTS_HAKATASHI_TOKEN" $H/activitypub/bots/operator-token
# 発行済みのものをすべて失効させる
curl -s -X DELETE -H "x-hakatashi-token: $BOTS_HAKATASHI_TOKEN" $H/activitypub/bots/operator-token
```

## 外部のプログラムから投稿する

通常の Mastodon API に、オペレータートークンと `X-Bot-Account` ヘッダを付ける。

```bash
# 投稿(visibility を省くとボットの既定の公開範囲)
curl -s -X POST -H "Authorization: Bearer $OP" -H 'X-Bot-Account: weather' \
  -H 'Idempotency-Key: 2026-10-23-morning' $H/api/v1/statuses -d status='今日は晴れ'
# リポスト: URL を解決してから reblog する
ID=$(curl -s -G -H "Authorization: Bearer $OP" -H 'X-Bot-Account: weather' $H/api/v2/search \
  --data-urlencode "q=<投稿の URL>" -d resolve=true -d type=statuses | jq -r '.statuses[0].id')
curl -s -X POST -H "Authorization: Bearer $OP" -H 'X-Bot-Account: weather' $H/api/v1/statuses/$ID/reblog
```

- メディアは `POST /api/v2/media` でアップロードして `media_ids[]` で添付するか、ボット限定で `media_urls` を使って外部 URL の直リンク画像を直接添付できる (→ ADR-0162)。
  ```bash
  # 外部画像の直リンク添付 (POST /api/v2/media 不要)
  curl -s -X POST -H "Authorization: Bearer $OP" -H 'X-Bot-Account: weather' \
    -H 'Content-Type: application/json' $H/api/v1/statuses -d '{
      "status": "気象レーダー画像です",
      "media_urls": [
        {
          "url": "https://example.com/radar.png",
          "description": "雨雲レーダー",
          "mime_type": "image/png",
          "width": 1200,
          "height": 800,
          "blurhash": "LEHLk~WB2yk8pyo0adR*.7kCMdnj"
        }
      ]
    }'
  ```
- masto.js などのライブラリでは、リクエストに追加のヘッダとして `X-Bot-Account` を渡す。
- ヘッダがない・未知のボットなら 401、ボットでない actor(インスタンス actor など)なら 403。
- ボットとして読む API(ホーム、通知など)は正しく動かない(→ [`known-issues.md`](../known-issues.md))。

## フォローされない・承認されないとき

- 許可リストにない actor の Follow には `Reject` を返す。相手のクライアントでは「フォローしていない」に戻る。
- 承認漏れの補正: `cd functions && GCLOUD_PROJECT=activitypub-firebase-bots FIREBASE_CONFIG='{"projectId":"activitypub-firebase-bots"}' npx tsx bin/reconcilePendingFollows.ts --actor <username> --dry-run`

## デプロイと初回のセットアップ

- main への push で、本番・dev と同じく CI がデプロイする。Hosting はターゲット `bots`(public は `hosting/bots/`)。
- 手でデプロイするとき(初回など)は、ターゲットを明示する: `firebase deploy --only hosting:bots -P activitypub-firebase-bots`。
- 初回のセットアップでは、Functions のデプロイのあとに一度だけインスタンス actor を作る:
  `curl -s -H "x-hakatashi-token: $BOTS_HAKATASHI_TOKEN" $H/activitypub/createAdmin`。
  **2回目以降は呼ばない**(鍵が作り直される)。
- `beforeUserCreate`(ブロッキング関数)を deploy するには、Authentication を Identity Platform にアップグレードしておく必要がある。
- 新しいプロジェクトでは、初回の deploy が 409(ソースのバケットの作成の競合)や Eventarc の権限の反映待ちで一部失敗する。
  数分おいて、もう一度 deploy すればよい。成果物のクリーンアップポリシーは
  `firebase functions:artifacts:setpolicy -P <project> --location asia-northeast1` で設定する。
