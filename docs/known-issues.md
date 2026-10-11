# 既知の問題

2026-10-10 時点(Phase 4 完了時)に残存を確認したもの。
**推測ではなく、コードを読んで確認した事実のみを記載する。**
修正したらこのファイルから削除する(履歴は git に残る)。

## ActivityPub 仕様準拠

### inbox の side effect が限定的

apex が処理するのは `Accept` / `Announce` / `Delete` / `Like` / `Reject` / `Undo` / `Update`。
`Follow` は apex 側にケースがなく、`functions/src/activitypub.ts` の `apex-inbox` リスナーで
自前実装している。`Move` は apex が完全に非対応。


## Mastodon API

### 期限切れの OAuth トークンが残り続ける

`POST /oauth/revoke` による失効には対応しているが、期限切れのアクセストークン・
リフレッシュトークン・認可コードを `functions/src/mastodon/oauth2Model.ts` の外から掃除する仕組みがない。


## 性能

### Functions と Firestore のリージョンが異なる

Cloud Functions は `us-central1`、Firestore は `asia-northeast1` にあり (本番・dev とも)、
Firestore の RPC ごとに太平洋を往復する。Follow 殺到の負荷試験 (#282) では、
単一ドキュメントの読み取りに約 300ms、inbox の1リクエスト全体に約 5 秒かかっており、その大半がこの往復だった (→ #285)。

### 投稿時の宛先解決がフォロワー数に比例する

apex の `address` (`functions/src/apex/pub/activity.ts`) は followers コレクションの各 actor を
`resolveObject` で1件ずつ Firestore から読む。フォロワー 500 人で `POST /api/v1/statuses` に約 13 秒かかった (#271、→ #286)。
