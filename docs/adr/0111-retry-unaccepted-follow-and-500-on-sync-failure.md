# ADR-0111: 未承認 Follow の再送を受理し、同期処理の失敗時は 500 を返す

- **Status:** Accepted
- **Date:** 2026-10-10

## 背景

Issue #258。Follow の受信時、`onApexInbox` での承認処理 (フォロー関係射影の更新、Accept の enqueue 等) が例外で失敗しても、`runPostWorkBeforeSend` ([ADR-0013](0013-scoped-postwork-middleware.md)) が例外を握りつぶして 200 を返していた。相手 (Mastodon) は配送成功と判断し、引っ越し処理 (`MigratedFollowDeliveryWorker`) で旧アカウントのフォローを解除してしまう。また相手が再送しても、apex は既に保存済みのアクティビティを重複配送 (`isNew: false`、[ADR-0049](0049-save-activity-return-contract-and-inbox-dedup.md)) として無視するため、二度と承認されなかった。

## 決定

1. **同期処理 (`runPostWork`) の例外時は 500 を返す。** `runPostWorkBeforeSend` で例外を catch した場合、レスポンスが未送出なら `500 Internal Server Error` を返して送信元に再送を促す。
2. **未承認の Follow は重複配送であってもイベントを発火する。** apex の `inboxSideEffects` で、`isNewActivity === false` であっても、アクティビティが Follow かつ受信者の `followers` コレクションに含まれていない (`!apex.hasMeta(activity, 'collection', first(recipient.followers))`) 場合は無視せず、`apex-inbox` イベントを発火してリスナーに渡す ([ADR-0042](0042-apex-fork-responsibility-boundary.md) の境界に基づくフォーク側修正)。
3. **承認処理を冪等にする。** `onApexInbox` で `acceptFollow`・`markActivityPublic`・`addToOutbox` を実行する。既に followers に入っている Follow が再送された場合は `isNewActivity === false` で素通りして 200 を返し、何もしない。
4. **承認漏れ修復スクリプト (`functions/bin/reconcilePendingFollows.ts`) を提供する。** inbox に届いており followers に含まれていない Follow を列挙し、承認と Accept 送信を行う。

## 理由

- エラー時に 5xx を返すことで ActivityPub / HTTP の再送仕様が機能する。
- apex の責務は重複配送の判定であり、「未完了の Follow」をアプリ層に通知するのは apex の役割である。自動承認の成否や Accept の送出は本体側の責務 ([ADR-0042](0042-apex-fork-responsibility-boundary.md))。
- 射影の更新 ([ADR-0082](0082-project-follow-relations-in-store.md)) は差分更新のため、仮に同一 Follow を再処理してもカウンタは二重に増えない。

## 結果

- Follow 承認中にトランザクション競合等で失敗しても、500 により相手が再送し、再送時に正常に承認される。
- 過去に承認漏れした Follow もスクリプトで一括修復できる。

## 参照

- [[0013-scoped-postwork-middleware]]、[[0042-apex-fork-responsibility-boundary]]、[[0049-save-activity-return-contract-and-inbox-dedup]]、[[0082-project-follow-relations-in-store]]
- 関連 Issue: [#258](https://github.com/hakatashi/activitypub-firebase/issues/258)
