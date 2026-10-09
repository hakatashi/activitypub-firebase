# 既知の問題

2026-10-07 時点(Phase 3.5 完了時)にコードを読み直して残存を確認したもの。
2026-10-10 に Phase 4 の確認(#231)で見つけたものを足した。
**推測ではなく、コードを読んで確認した事実のみを記載する。**
修正したらこのファイルから削除する(履歴は git に残る)。

## ActivityPub 仕様準拠

### inbox の side effect が限定的

apex が処理するのは `Accept` / `Announce` / `Delete` / `Like` / `Reject` / `Undo` / `Update`。
`Follow` は apex 側にケースがなく、`functions/src/activitypub.ts` の `apex-inbox` リスナーで
自前実装している。`Move` は apex が完全に非対応。

### キャッシュしたリモート actor が更新されない

リモート actor は相手から `Update(Person)` が届いたときだけ上書きされる。`remoteActorRefreshTask`
(ADR-0104)が取り直すのは件数だけで、actor 本体は取り直さない。相手がアバターを変えても `Update` を
受け取れていなければ、古い(404 の)アバター URL を返し続ける(#253)。

## Mastodon API

### 画像のない Account の `avatar` / `header` が空文字列

`functions/src/mastodon/presenters/account.ts` は `icon` / `image` がない actor で空文字列を返す。
Mastodon は `missing.png` の URL を返すので、Elk はヘッダーのないアカウントのプロフィールで壊れた画像を出す(#252)。

### 期限切れの OAuth トークンが残り続ける

`POST /oauth/revoke` による失効には対応しているが、期限切れのアクセストークン・
リフレッシュトークン・認可コードを `functions/src/mastodon/oauth2Model.ts` の外から掃除する仕組みがない。

