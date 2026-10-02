# ADR-0060: Status エンティティの属性を Note の実データから導出する

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

`noteObjectToStatus` は Status の大半を固定値で返しており、`visibility` / `in_reply_to_id` /
カウント類などが実態と食い違っていた (Issue #57)。タイムラインの絞り込みも `visibility` を必要とする。

## 決定

- 導出ロジックは Firestore に触らない純粋関数として `functions/src/mastodon/statusAttributes.ts` に置く。
  リプライ先の ID など外部参照が要るものは `StatusContext` として呼び出し側 (`getAllNotes`) が渡す。
- `visibility`: `as:Public` が `to` → public / `cc` → unlisted / followers IRI が `to`/`cc` → private /
  それ以外 → direct。followers IRI は未指定なら `{attributedTo}/followers` で推定する。
- `uri` は `note.id` (AP の IRI) をそのまま返し、`url` は Note の `url`、無ければ IRI を返す。
- `in_reply_to_id` は**手元に保存済みの**リプライ先だけ解決し、リモートへは取りに行かない (→ ADR-0059)。
  解決できなければ `null`。
- カウントは `_meta.likesCount` / `_meta.sharesCount` (→ ADR-0037) を優先し、無ければ Note 自身の
  `likes` / `shares` / `replies` の `totalItems`、それも無ければ 0。
- `application` はローカル投稿のみ。リモート投稿では `null` (masto の型は non-null なので `StatusEntity` で補う)。
- `language` は `contentMap` の最初のキー、無ければ `null`。`edited_at` は `updated` が `published` と
  異なるときだけ入れる。
- `mentions` の `id` はアカウント ID を解決できないため外部アカウントのプレースホルダ `'1'` を入れる。
- `media_attachments` は Phase 4 (メディア) まで空配列。
