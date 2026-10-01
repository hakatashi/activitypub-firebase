# ADR-0061: タイムラインは actor で絞り、可視性を1箇所で判定する

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

`getAllNotes()` は全 Note を無条件に返し、非公開投稿が公開タイムラインへ漏れうる状態だった (Issue #58、→ ADR-0005)。

## 決定

- 可視性は `statusAttributes.ts` の `noteToVisibility` を唯一の判定元とし、閲覧可否は
  `isNoteVisibleTo(note, viewer, viewerFollowing)` に集約する。Status の `visibility` と同じ関数を使う。
  - public / unlisted は誰でも可。private は投稿者本人、viewer がフォロー中の投稿者、または宛先に含まれる場合のみ。
    direct は投稿者本人か宛先のみ。
- 公開タイムラインは `public` のみ (unlisted は載せない)。
- `accounts/:id/statuses` は `:id` の actor の投稿のみ。認証は任意で、あれば viewer として判定する。
- `home` は「自分 + フォロー中 (Accept 済みの自分発 Follow の対象)」の投稿のうち閲覧可能なもの。
- 取得は `ApexStore.getNotes({ actors, limit, before })`。可視性は Firestore で絞れないため、
  新しい順に読み、足りなければ `published` カーソルで読み足す (上限ラウンド数あり)。
  複合インデックス `type + attributedTo + published` を追加する。
- `limit` は既定 20、最大 40。カーソルページネーションは → ADR-0062。
