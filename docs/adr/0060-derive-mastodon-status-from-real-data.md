# ADR-0060: Status エンティティを Note の実データから導出する

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

[[ADR-0006]]・[[ADR-0058]] で Mastodon ID の採番と IRI マッピングを整備したが、
`noteObjectToStatus` は大半のフィールドを固定値 (`in_reply_to_id: null`, `visibility: 'public'`,
`replies_count: 0`, `reblogs_count: 0`, `favourites_count: 0` 等) で返していた。
Elk などのクライアントがリモート/ローカル投稿を正しく識別・表示できず、フェデレーション上の同一性が崩れていた。

## 決定

- **`noteObjectToStatus` は純粋な同期関数のまま保ち、外部解決が必要なデータはコンテキストで渡す。**
  - 単体テストの容易性を保ちつつ、タイムライン取得時の N+1 クエリを排除する。
- **各フィールドは Note の実データから次の規則で導出する:**
  - `visibility`: `to` / `cc` のアドレスから判定 (`as:Public` in `to` → `public`、`as:Public` in `cc` → `unlisted`、
    followers IRI → `private`、個別 actor のみ → `direct`)。タイムライン絞り込みと共通化可能な純粋関数として切り出す。
  - `uri` / `url`: `uri` には AP IRI (`note.id`) をそのまま渡し、`url` は Note の `url` (Web リンク) または自ドメインの URL。
  - `in_reply_to_id` / `in_reply_to_account_id`: `inReplyTo` の親 Note を解決し、親の Mastodon ID と親投稿者の Account ID を設定。未キャッシュなら `null`。
  - `sensitive` / `spoiler_text`: Note の `sensitive` (boolean) と `summary` (string) から取る。
  - `language`: `contentMap` の先頭キー。ローカル投稿のフォールバックは `'ja'`、リモートは `null`。
  - `edited_at`: Note の `updated` から ISO 文字列化。無ければ `null`。
  - `replies_count` / `reblogs_count` / `favourites_count`: Note の `replies` / `shares` / `likes` の `totalItems`、
    および `_meta.likesCount` / `_meta.sharesCount` ([[ADR-0037]]) を参照する。
  - `tags` / `mentions`: Note の `tag` から `Hashtag` / `Mention` を抽出。
  - `application`: 自ドメインのローカル投稿のみ設定し、リモート投稿は `null`。
  - `media_attachments`: Phase 4 (メディア) まで空配列固定。

## 理由

- 各種クライアントでリモート投稿のリンクやリプライツリー、CW、ハッシュタグ、メンションが正常に機能する。
- 同期関数 + バッチ解決の分離により、一覧 API のクエリ効率とテスト容易性が両立する。

## 結果

- `functions/src/mastodon/api.ts` の `noteObjectToStatus` および `getAllNotes` を改修。
- `getStatusVisibility` などの判定関数を単体テストで固定。

## 参照

- 関連 Issue: [#57](https://github.com/hakatashi/activitypub-firebase/issues/57)
- 関連 ADR: [[ADR-0006]], [[ADR-0037]], [[ADR-0058]]
- `third_party/mastodon/app/lib/activitypub/parser/status_parser.rb`
