# ADR-0064: GET / DELETE /api/v1/statuses/:id と /context のスレッド走査・削除仕様

- **Status:** Accepted
- **Date:** 2026-10-03

## 背景

個別投稿の表示・削除およびスレッド表示のエンドポイントがなく、クライアントで個別投稿を開いたり削除したりできない (Issue #61)。

## 決定

1. **`GET /api/v1/statuses/:id`**
   - Mastodon ID から Note を取得し、Status を返す。未認証または閲覧権限がない場合は 404 を返す (存在秘匿)。
2. **`DELETE /api/v1/statuses/:id`**
   - `write:statuses` (または `write`) スコープを要求する。
   - 自分の投稿でない場合は 404 を返す (存在秘匿)。
   - 削除前の Note から本文 (`text`) を含む Status エンティティを生成してレスポンスに返す。
   - Note を Tombstone 化して保存し、Delete アクティビティを outbox に積んでフォロワーへ配送する。
   - `statuses_count` は `onStreamCreated` で Delete ストリーム作成時にアトミック減算する ([[ADR-0039]]、[[ADR-0063]] と一貫)。
3. **`GET /api/v1/statuses/:id/context`**
   - `{ ancestors: [], descendants: [] }` を返す。対象 Note が未存在または閲覧権限がなければ 404。
   - `ancestors`: `inReplyTo` を上限 40 件まで遡る。手元にないリモート Note は HTTP で取りに行かない ([[ADR-0059]])。訪問済み Set で循環参照を防止し、根から手前 (古い順) に並べる。
   - `descendants`: 対象 Note の IRI を `inReplyTo` に持つ Note を手元から深さ優先 (DFS) で集める (深さ上限 20、件数上限 60)。手元にない Note は取りに行かない。
   - `inReplyTo` の保存形式は配列とし、`getReplies` は `Filter.or` (`==` / `array-contains`) で引く。`objects` に `(type, inReplyTo, _meta.published)` の複合インデックス (ASC / CONTAINS) を追加する。
   - いずれも閲覧者 (認証任意) に対する可視性フィルタを通す。

## 理由

- リモート Note を同期取得しないことで、サーバーレス環境のタイムアウトと SSRF のリスクを避ける。
- `statuses_count` の更新を `onStreamCreated` に集約することで、Create 加算と Delete 減算の責務を一貫させる。

## 結果

- 個別投稿の閲覧・削除・スレッド表示が動作する。
- 手元に存在しない祖先や子返信は context に含まれない。

## 参照

- 関連 ADR: [[ADR-0039]]、[[ADR-0059]]、[[ADR-0060]]、[[ADR-0063]]
- 関連コード: `functions/src/mastodon/api.ts`、`functions/src/notes.ts`、`functions/src/denormalizations.ts`
