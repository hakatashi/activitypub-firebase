# ADR-0100: お気に入り・ブックマーク一覧のカーソルを射影・ブックマークのドキュメントに `cursorId` として持つ

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

Issue #223。`GET /api/v1/favourites` / `GET /api/v1/bookmarks` は空配列のスタブだった。
Mastodon のこの 2 つは、カーソルが Status の ID ではなくお気に入り・ブックマーク自体の内部 ID で、
「お気に入りした / ブックマークした順」(新しい順) に返す (`third_party/mastodon_documentation/content/en/methods/favourites.md`)。
クライアントは `Link` ヘッダをたどるだけなので、カーソルの中身は自由に決めてよい。ADR-0062 を拡張する。

## 決定

1. **お気に入り (`userInfos/{actor}/favourites/{Note}`、ADR-0084) に `cursorId` を持たせる。**
   値は `activityIris` の Like の Mastodon ID のうち最大のもの (最新の Like)。採番済みの ID がなければ `null`。
   射影の更新 (`prepareReactionProjectionUpdate`) で、追加した Like の ID は Store が採番した値を受け取り、
   残っている他の Like の ID は同じトランザクション内で `mastodonIdsByIri` から読む。
   同じ Note への Like が 1 件だけの通常の場合、追加の読み取りは発生しない。ブーストの射影にも同じ規則で入れる。
2. **ブックマーク (`userInfos/{actor}/bookmarks/{Note}`、ADR-0070) に `cursorId` を持たせる。**
   AP に対応するアクティビティがないので、ブックマーク時刻から `buildMastodonId(時刻, 乱数シーケンス)` で作る。
   `mastodonIds` には登録しない (Status などの ID として引かれることがなく、一意である必要があるのは
   1 ユーザーのブックマークの中だけ)。同一ミリ秒の衝突はシーケンスの乱数で避ける。
   既にブックマーク済みの Note を再度ブックマークしても `createdAt` / `cursorId` は変えない (Mastodon と同じ)。
3. **読み取り。** `social/noteCollections.ts` で、サブコレクションを `cursorId` の範囲と並びで読む関数を
   お気に入りとブックマークで共有する (`getFollowersPageEntries` と同じ形)。`cursorId` が `null` の
   ドキュメントは範囲条件で落ちる。閲覧できない Note (Tombstone、消えたもの、`isNoteVisibleTo` で見えないもの、
   投稿者が引けないもの) は飛ばし、limit に満たなければ続きを読み足す。
   `Link` には **読み進めたドキュメントのカーソル** の両端を渡す。飛ばしたものも含めるので、次のページで同じものを読み直さない。
   `limit` は既定 20、最大 40。
4. 既存データは、お気に入りは `functions/bin/backfillReactionProjection.ts` で `cursorId` も組み立て直し、
   ブックマークは `functions/bin/backfillBookmarkCursor.ts` で `createdAt` から埋める。

## 結果

- デプロイからバックフィルまでの間、既存のお気に入り・ブックマークは一覧に出ない (単一ユーザー運用なので許容)。
- 単一フィールドの範囲 + 並べ替えなので、複合インデックスは不要。

## 参照

- [[0062-cursor-pagination-by-mastodon-id]]、[[0084-project-favourites-and-reblogs]]、[[0070-status-viewer-attributes-and-storage]]、[[0006-mastodon-api-id-scheme]]
- 関連 Issue: [#223](https://github.com/hakatashi/activitypub-firebase/issues/223)
