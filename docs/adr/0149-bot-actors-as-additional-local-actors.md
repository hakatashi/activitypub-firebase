# ADR-0149: ボットを、主 actor と同じ形の追加のローカル actor として持つ

- **Status:** Accepted
- **Date:** 2026-10-23
- **Supersedes:** [ADR-0005](0005-single-user-multi-ready-data-model.md) の「複数アカウントの登録 UI・API は実装しない」のうち、ボットに関する部分

## 背景

個人用のボット(フィードの転載、リポスト、気象情報など)を運用したい(#315)。投稿のロジックは外部の
プログラムが持ち、このプロジェクトは API で受けて連合に流すだけにする(ADR-0151)。
ボットは1つのインスタンスに上限なく作れるようにする。

## 決定

1. ボットは、主 actor と同じく `objects` の actor(鍵を含む)と `userInfos/{actor}` を持つ。
   actor の type は `Service`、UserInfo は `bot: true`・`uid: null` とし、フォローの承認ポリシー(ADR-0150)を持つ。
2. 作成は管理エンドポイント `POST /activitypub/bots`(`adminOnly`)で行う。username は `^[a-z0-9_]{1,30}$` で、
   すでにある actor の名前は 409 にする(`createAdmin` と違い、鍵を上書きしない)。数の上限は設けない。
   一覧は `GET /activitypub/bots`、ポリシーの変更は `PATCH /activitypub/bots/:username`。削除は今は作らない。
3. ボット機能は `InstanceConfig.bots.enabled`(ADR-0148)が有効なインスタンスでだけ使える。本番では無効にする。
4. 「ローカル actor か」の判定に `isLocalActorIri(iri)` を足す。IRI が `https://{domain}/activitypub/u/` で
   始まるかを見るだけで、読み取りはしない。
5. ボットにも効かせる必要がある箇所だけを一般化する。リアクションの射影(リブログの重複判定と取り消し)、
   ステータスとプロフィールの URL・リンクプレビュー用のページ、未承認の Follow の補正(ADR-0111)。
6. 通知・フォロー関係・ホームやリストのタイムラインの射影は、主 actor 専用のままにする。

## 理由

- apex のルート・inbox・WebFinger・配送の署名・`publishNote` は、すでに actor ごとに動く。
  データの形を主 actor と揃えれば、追加の仕組みはほとんど要らない。
- ボットは Mastodon API で通知やタイムラインを読まない。射影をすべて一般化するのは、使い道に比べて大きすぎる。

## 結果

- ボットの視点で読む API(ホーム、通知、relationships など)は空か不正確になる([`known-issues.md`](../known-issues.md))。
- ボットを Elk などでログインして使うことはできない。

## 参照

- 関連 ADR: [ADR-0148](0148-instance-config-per-project.md)、[ADR-0150](0150-bot-follow-approval-policy.md)、[ADR-0151](0151-bot-operator-token.md)、[ADR-0152](0152-bots-instance-in-separate-project.md)
