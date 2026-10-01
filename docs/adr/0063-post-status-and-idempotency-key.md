# ADR-0063: POST /api/v1/statuses の Note 組み立てと Idempotency-Key の保持

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

投稿は管理者用の `/activitypub/createPost` からしかできず、宛先は public 固定だった (Issue #60)。
Elk などのクライアントはネットワークエラー時に `Idempotency-Key` 付きで再送するため、
これを扱わないと投稿が重複する。Mastodon は Redis に1時間キーを保持している
(`third_party/mastodon/app/services/post_status_service.rb`)。

## 決定

- Note の組み立てと配送は `functions/src/notes.ts` の `publishNote` に集約し、`createPost` もこれを使う。
- 宛先は Mastodon の `ActivityPub::TagManager` に合わせる。public: to=Public, cc=followers /
  unlisted: to=followers, cc=Public / private: to=followers / direct: to=宛先のみ。
  メンションの解析は未実装なので、**リプライ先の投稿者 (自分以外) を宛先に加える** ことで代替する
  (direct ではこれが唯一の宛先)。
- `status` はプレーンテキストとして HTML エスケープし、空行で `<p>`、改行で `<br />` に変換する。
  リンク・メンション・ハッシュタグの自動リンクは行わない。
- `spoiler_text` → `summary`、`sensitive` → `sensitive` (`spoiler_text` があれば常に true)、
  `language` → `contentMap`。本文が空で `spoiler_text` があれば本文に回す (Mastodon と同じ)。
- `media_ids` / `poll` / `scheduled_at` は Phase 4 まで未対応。空でない値が来たら 422 を返す。
- `in_reply_to_id` が手元で解決できなければ 404 を返す (Mastodon と同じ)。
- 権限は `write:statuses` または `write` スコープを要求し、無ければ 403。
- `Idempotency-Key` は Firestore の `idempotencyKeys` に `sha256(actor IRI + キー)` をドキュメント ID として、
  **Note を作る前に** 予約する (`noteIri` を先に採番して書く)。予約はトランザクションで行い、
  期限内のレコードがあれば新規作成せず、その Note の Status を 200 で返す。
  Note がまだ保存されていなければ処理中として 503 を返す (Mastodon のロック取得失敗と同じ)。
  作成に失敗したら予約を消す。
- 期限は `expiresAt` (作成から1時間) に持ち、読み出し時に判定する。物理削除は Firestore の
  TTL ポリシー (`firestore.indexes.json` の `fieldOverrides`) に任せる。
- `statuses_count` は従来どおり `onStreamCreated` が Create の保存で加算する (→ ADR-0039)。API 側では加算しない。

## 理由

予約を Note 作成より前に行うことで、並行した再送でも Note は1件しか作られない。
Note 作成後にキーを記録する方式では、その間に届いた再送が二重投稿になる。
TTL ポリシーの削除は最大24時間遅れるため、期限判定は読み出し時にも行う必要がある。

## 結果

- direct はリプライでない限り誰にも配送されない。メンション解析の実装時に宛先の算出を置き換える。
- 本文中の URL・メンション・ハッシュタグはリンクにならない。

## 参照

- 関連 ADR: [[ADR-0039]]、[[ADR-0058]]、[[ADR-0060]]
- 関連コード: `functions/src/notes.ts`、`functions/src/idempotency.ts`、`functions/src/mastodon/api.ts`
