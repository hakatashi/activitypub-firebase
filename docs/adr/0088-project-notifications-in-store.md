# ADR-0088: 受信したアクティビティを通知として userInfos に射影し、Store で差分更新する

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Issue #221。通知の保存先がなく、通知 API(#222)の実装に向けて通知データを保持する必要がある。
フォロー関係(ADR-0082)やお気に入り・ブースト(ADR-0084)と同様に、受信したアクティビティからユーザー別の通知を
Firestore のサブコレクションに射影し、Store のトランザクション内で差分更新する。

## 決定

1. **データモデル。** `userInfos/{ローカル actor}/notifications/{アクティビティ IRI}` に 1 件ずつ保存する。
   ドキュメント ID はアクティビティ IRI(`escapeFirestoreKey`)。フィールドは `id`(アクティビティの Mastodon ID)、
   `type`(`mention` | `favourite` | `reblog` | `follow`)、`activityIri`、`accountIri`(起こした actor)、
   `statusIri`(対象の Note IRI。follow は null)、`createdAt`。
2. **通知にする出来事と条件。**
   - `mention`: 受信した `Create(Note)` で、Note の `tag` にローカル actor を `href` とする `Mention` があるもの。`to`/`cc` のみの直接宛先は silent mention 扱いとし通知しない。
   - `favourite`: 受信した `Like` で、対象がローカル actor の Note。
   - `reblog`: 受信した `Announce` で、対象がローカル actor の Note。
   - `follow`: 受信した `Follow` で、`object` がローカル actor。
   - 送信者がローカル actor 自身のアクティビティや自分の投稿へのリアクションは通知しない。
   - `update`・`poll`・`status`・`admin.*` などは対象外とする。
3. **更新のタイミング。**
   - 作成: `Store#saveActivity` で新規保存時(`existingData === undefined`)。重複配送や別コレクション追加(`'new collection'`)では作らない。
   - 削除: 相手の Undo による `Store#removeActivity` で元のアクティビティが消えたとき、同じトランザクションで通知を消す。
   - Note の削除(Delete → Tombstone 化)では通知を削除せず、読み取り側(#222)で除外する。
   - 冪等性: ドキュメント ID をアクティビティ IRI で一意にし、既存があれば再作成せず、存在しない削除でも落ちない。
4. **実装とバックフィル。** `functions/src/projections/notifications.ts` に置き、`prepareProjectionUpdates` に登録する。
   `projections/` から `social/` や `mastodon/` を import しない。
   既存アクティビティからの再構築には `functions/bin/backfillNotificationProjection.ts` を使う。

## 結果

- 受信アクティビティから通知への変換が Store のトランザクション内で自動的に行われる。
- 読み取り側(#222)は通知コレクションから直接一覧を取得できる。

## 参照

- [[0006-mastodon-api-id-scheme]]、[[0082-project-follow-relations-in-store]]、[[0084-project-favourites-and-reblogs]]
- 関連 Issue: [#221](https://github.com/hakatashi/activitypub-firebase/issues/221)
