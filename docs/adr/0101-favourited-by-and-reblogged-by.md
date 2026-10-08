# ADR-0101: `favourited_by` / `reblogged_by` は streams を全件読んでアプリ側でページングする

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

Issue #224。`GET /api/v1/statuses/:id/favourited_by` / `reblogged_by` が未実装だった。
Mastodon はお気に入り・ブーストの内部 ID をカーソルに、新しい順で Account を返す
(`third_party/mastodon_documentation/content/en/methods/statuses.md`、limit 既定 40 / 最大 80)。
誰がお気に入り・ブーストしたかの一覧は射影になく (ADR-0084 の射影はローカル actor 側から引くもの)、
`streams` の Like / Announce にしかない。`streams` の `_meta.published` は Announce にしかない (ADR-0096)。

## 決定

1. **`streams` を `type` と `_meta.index.objects` (ADR-0021) の等価条件で全件読み、アプリ側で並べてページングする。**
   単一ユーザーのサーバーで 1 つの Note に届く Like / Announce は多くても数百件で、全件読みのコストは小さい。
   Like に並べ替えキーを足すための書き込み・バックフィル・複合インデックスを増やさずに済む。
   等価条件だけなので複合インデックスは不要 (単一フィールドインデックスのマージで引ける)。
2. **カーソルはアクティビティの Mastodon ID** (ADR-0062 の followers と同じ考え方)。
   Store が保存時に採番している (ADR-0058) ので `getMastodonIds` で引き、`takePage` で切り出す。
3. 同じ actor の Like / Announce が複数残っていれば、最新の 1 件だけを数える (Mastodon は 1 アカウント 1 件)。
4. ブーストは Mastodon の `distributable_visibility` に合わせ、public / unlisted の Announce だけを返す。
5. 対象の Status は `loadVisibleStatus` で解決する。見えなければ 404。ブーストの ID なら元の Note を対象にする。
6. actor が `objects` にないものは飛ばす。`Link` には **ページとして切り出したアクティビティのカーソルの両端** を渡し、
   飛ばしたものも含める (ADR-0100 と同じ。次のページで読み直さず、全件飛ばしたページでもカーソルが途切れない)。

## 結果

- `_meta.index` は onStreamWritten が遅れて書くため、受信直後の数秒は一覧に出ないことがある。
- 知っているのは自サーバーに届いた分だけ (リモートの投稿へのリモートからの Like は普通届かない)。Mastodon も同じ。
- 件数が増えて全件読みが重くなったら、Like / Announce にも並べ替えキーを持たせて Firestore 側で範囲を絞る ADR で supersede する。

## 参照

- [[0021-meta-index-as-maps]]、[[0058-mastodon-id-snowflake-layout]]、[[0062-cursor-pagination-by-mastodon-id]]、[[0084-project-favourites-and-reblogs]]、[[0100-cursor-for-favourites-and-bookmarks]]
- 関連 Issue: [#224](https://github.com/hakatashi/activitypub-firebase/issues/224)
