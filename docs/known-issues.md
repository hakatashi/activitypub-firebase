# 既知の問題

2026-10-20 時点(pawoo.net からの引っ越しの完了時)に残存を確認したもの。
**推測ではなく、コードを読んで確認した事実のみを記載する。**
修正したらこのファイルから削除する(履歴は git に残る)。

## ActivityPub 仕様準拠

### inbox の side effect が限定的

apex が処理するのは `Accept` / `Announce` / `Delete` / `Like` / `Reject` / `Undo` / `Update`。
`Follow` は apex 側にケースがなく、`functions/src/activitypub.ts` の `apex-inbox` リスナーで
自前実装している。`Move` は apex が完全に非対応(2xx で受け取って捨てる。→ [ADR-0115](adr/0115-inbox-4xx-only-for-sender-faults.md))。
`Add` / `Remove` は副作用を行わない方針だが(→ [ADR-0141](adr/0141-ignore-inbox-add-remove.md))、
object が Note のもの(Mastodon のピン留め)には 400 を返している → [#363](https://github.com/hakatashi/activitypub-firebase/issues/363)。

### 仕様の S2S 部分との照合で見つかった非準拠

条文ごとの判定は [`activitypub-s2s-compliance.md`](activitypub-s2s-compliance.md) にある。特に影響の大きいもの:

- inbox が `Create` / `Announce` に埋め込まれた別オリジンのオブジェクトを、検証せずに保存する(なりすましが可能)
  → [#362](https://github.com/hakatashi/activitypub-firebase/issues/362)

### リモートの取得が恒久的な 4xx で失敗しても、inbox が 500 を返す

ADR-0115 は相手の 4xx(408 / 429 以外)を恒久的な失敗と分類しているが、inbox の処理の中で起きた次の失敗は 500 になり、
送信側は再送の上限まで送り続ける。引っ越しの後、本番の inbox の 500 の大半はこれだった。

- **署名者の actor の取得**(`functions/src/apex/net/security.ts` の `error resolving signer for signature verification` → `res.status(500)`)。
  旧サーバーで削除・凍結されたアカウント(410)や、こちらをブロックした相手(401)からの `Block` などで起きる
  → [#327](https://github.com/hakatashi/activitypub-firebase/issues/327)
- **第三者のオブジェクトの取得**(`Announce` / `Like` の `object` が 401 / 404)。末尾のエラーハンドラ(`responders.serverError`)が 500 にする
  → [#322](https://github.com/hakatashi/activitypub-firebase/issues/322)

### `@context` に `https://w3id.org/identity/v1` を含むアクティビティに 503 を返す

`functions/src/apex/pub/utils.ts` の `coreContexts` が同梱しているのは security/v1・activitystreams・webfinger の3つだけ。
identity/v1 は配信元(web-payments.org)が消えていて取得できず、`jsonldContextLoader` の一時的な失敗として 503 を返し続ける
(GoToSocial 系の Follow などが該当)。**本番は Firestore の `contexts` に手で1件入れて回避している。dev には入っていない**
→ [#325](https://github.com/hakatashi/activitypub-firebase/issues/325)。

## Mastodon API

### 期限切れの OAuth トークンが残り続ける

`POST /oauth/revoke` による失効には対応しているが、期限切れのアクセストークン・
リフレッシュトークン・認可コードを `functions/src/mastodon/oauth2Model.ts` の外から掃除する仕組みがない。

### ボットの視点で読む API が空か不正確になる

通知・フォロー関係・ホームやリストのタイムラインの射影は主 actor 専用で
(`functions/src/projections/notifications.ts`、`follows.ts`、`timelineFeeds.ts` が `localActorId` で判定する)、
ボットの `userInfos/{actor}` には書かれない(→ [ADR-0149](adr/0149-bot-actors-as-additional-local-actors.md))。
ボットとして呼んだホーム・通知・relationships・フォロー中の一覧などは、空か不正確な結果を返す。
