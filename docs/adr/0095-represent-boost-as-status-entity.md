# ADR-0095: ブースト(Announce)を Status エンティティとして表現する

- **Status:** Accepted
- **Date:** 2026-10-08

## 背景

`POST /api/v1/statuses/:id/reblog` は元の Note の Status をそのまま返していた (Issue #211)。
Mastodon 仕様では、ブーストの応答はトップレベルの `id` がブースト(Announce)自身の ID であり、
`reblog` プロパティに元の Status が入る。Elk などのクライアントは応答の `reblog` を元の Status として
読むため、`reblog: null` だと例外が発生してクライアント上でエラーとなっていた。

## 決定

1. **ブースト用 presenter の導入。** `functions/src/mastodon/presenters/status.ts` に
   Announce アクティビティを Status エンティティへ変換する `announceToStatus` を実装する。
   - トップレベルの `id` は Announce の Mastodon ID、`account` はブーストした actor の Account。
   - `reblog` にブーストされた元の Note の `StatusEntity` を入れる。
   - `content` は元の Note の `content`、`created_at` は Announce の `published`。
   - `reblogged` は `true`、`pinned` は `false`、`media_attachments` / `mentions` / `tags` / `emojis` は空配列とする。
2. **`POST /api/v1/statuses/:id/reblog` の応答。** ブースト実行後、作成または取得した Announce から
   上記 presenter を用いてブースト Status を生成して返す。
   `POST /api/v1/statuses/:id/unreblog` は Mastodon と同様に元の Note の Status をそのまま返す。
3. **`GET /api/v1/statuses/:id` の対応。** 指定された ID が Announce の Mastodon ID である場合も
   該当のブースト Status を返せるようにする (元の Note が非公開等で閲覧不能なら 404)。
4. **タイムラインへの Announce 混入。** ホームタイムラインやアカウントタイムラインへの
   ブースト表示は影響範囲が大きいため本 ADR では扱わず、別の Issue で判断する。

## 理由

- Elk などのクライアントでブースト時に `pageerror` が発生せず正常に動作する。
- Mastodon の API 仕様に準拠し、`POST /reblog` と `GET /statuses/:id` の整合性を保てる。

## 参照

- 関連 Issue: [#211](https://github.com/hakatashi/activitypub-firebase/issues/211)
- 関連 ADR: [[0006-mastodon-api-id-scheme]], [[0058-mastodon-id-generation-and-mapping]], [[0060-derive-status-attributes-from-note]], [[0084-project-favourites-and-reblogs]]
