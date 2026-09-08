# ADR-0033: inbox で受信した Undo の object を保存前に解決済みオブジェクトで埋め込む

- **Status:** Superseded by ADR-0048
- **Date:** 2026-09-08

## 背景

apex の `activity.save` は `['create', 'announce', 'like', 'add', 'reject']` のみ
`res.locals.apex.object` で解決されたオブジェクトを `activity.object` に埋め込んで保存するが、
`undo` は含まない。Mastodon は `Undo(Follow)` 送信時に Follow を丸ごと埋め込むため問題にならないが、
文字列 IRI で送られてくる一般的な ActivityPub 実装からの `Undo` では `Streams` に文字列 IRI のまま保存される。
その直後に `inboxSideEffects` が元の `Follow` を削除するため、Firestore の非同期トリガー `onStreamCreated` が
発火した時点では元の `Follow` は存在せず、`followers_count` を減算できない (Issue #53)。

## 決定

**`apex.net.inbox.post` の `activity.save` 直前に薄いミドルウェアを挿入し、受信した `Undo` の
`res.locals.apex.object` (ローカル DB から解決された対象アクティビティ) が存在する場合、
`req.body.object` を `[res.locals.apex.object]` で埋め込んでから保存させる。**
[ADR-0030](0030-inbox-redundant-delivery-detection.md) / [ADR-0031](0031-update-delete-same-origin-check.md)
と同様、apex 本体には手を入れずミドルウェアチェーンへの挿入で実現する。

## 理由

- 送信元の表現形式(Mastodon の埋め込み / 他実装の文字列 IRI)にかかわらず、`Streams` に保存される
  `Undo` ドキュメントの `object` が常に解決済みアクティビティを持つよう統一される。
- `onStreamCreated` トリガーは `isAPFollow(object)` で確実に Follow を検知でき、
  外部クエリや削除済みドキュメントに依存せず自己完結して `followers_count` を減算できる。
- 元の Follow が存在しない(未解決の)場合は埋め込みを行わず、トリガーも減算しないため安全。

## 結果

- 新規ファイル `functions/src/inboxUndo.ts` にミドルウェアを実装する。
- `functions/src/inboxPost.ts` に inbox post のミドルウェアパイプラインを統合し、`activitypub.ts` でフラットに実行する。
- 文字列 IRI の `Undo(Follow)` を受信しても `followers_count` が正しく減算される。


## 参照

- [[ADR-0002]] activitypub-express を継続利用し、配送層のみ差し替える
- [[ADR-0030]] inbox の重複配送検出を、apex 本体を変更せず前後の薄いミドルウェアで行う
- [[ADR-0031]] Update / Delete の同一オリジン検証を、apex 本体を変更せず前段ミドルウェアで行う
- 関連 Issue: [#53](https://github.com/hakatashi/activitypub-firebase/issues/53)
