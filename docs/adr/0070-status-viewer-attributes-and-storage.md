# ADR-0070: Status の認証ユーザー依存属性の導出と保存形式

- **Status:** Accepted
- **Date:** 2026-10-04

## 背景

Status エンティティの `favourited` / `reblogged` / `bookmarked` / `pinned` は
認証ユーザー (viewer) との関係によって決まるが、#57 では固定値 `false` を返していた (Issue #155)。
また AP に対応物が存在しない bookmark や、actor の `featured` コレクションに対応する pin について、
Firestore 上の保存先を確定する必要がある。

## 決定

- `favourited` / `reblogged` は viewer が送信した `Like` / `Announce` アクティビティを
  `streams` から取得し、viewer が送信した `Undo` と突き合わせて判定する (getFollowers と同等)。
- `bookmarked` は AP に対応物が無いため、`userInfos/{actorKey}/bookmarks/{noteKey}` に保存する。
- `pinned` は AP の `featured` コレクションに対応付け、`userInfos/{actorKey}/pins/{noteKey}` に保存する。
  Mastodon 仕様に従い、自身が投稿した Note のみピン留め可能とする。
- `StatusContext` に `viewer` (各 IRI の Set または boolean) を追加し、`noteObjectToStatus` は
  Firestore に触らない純粋関数のまま判定する。
- `notesToStatuses` に `viewer?: APActor` を渡し、対象 Note 群に対する viewer の状態を一括取得して渡す。

## 理由

- `Like` / `Announce` は AP の標準アクティビティであり、Outbox 送信時のストリーム記録を正として扱うことで
  連合との整合性を保てる。
- bookmark と pin を `userInfos` 配下のサブコレクションに置くことで、マルチユーザー対応のデータモデルを
  保ちつつ (→ ADR-0005)、ユーザーごとの一覧取得や削除が容易になる。

## 結果

- `noteObjectToStatus` が viewer との関係に応じた正しい boolean 値を返す。
- `POST /statuses/:id/(favourite|reblog|bookmark|pin)` およびその解除エンドポイントの保存先と判定が整合する。

## 参照

- 関連 Issue: [#155](https://github.com/hakatashi/activitypub-firebase/issues/155)
- 関連 ADR: [[0005-single-user-multi-ready-data-model]], [[0060-derive-status-attributes-from-note]]
