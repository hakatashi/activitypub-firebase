# ADR-0112: コレクションの変更時に Update を配送しない

- **Status:** Accepted
- **Date:** 2026-10-11

## 背景

Issue #259。フォロー承認 (Accept)、受信した Undo(Follow)、受信/送信した Reject、Like / Announce の受信・Undo 等で、apex はフォロワー全員へコレクション (`followers` / `following` / `liked` / `likes` / `shares`) の `Update` を配送している。

引っ越し (Phase 5) では短時間に数百件の Follow が届くため、配送タスク数がフォロワー数の2乗に比例して膨らむ。その結果、Cloud Tasks のキュー (`maxDispatchesPerSecond: 5`) を圧迫し、相手側が `follow_request` のまま待たされる `Accept` の配送が数十分遅延する。

Mastodon はコレクション (`OrderedCollection`) の `Update` を処理せず無視する (`third_party/mastodon/app/lib/activitypub/activity/update.rb` は actor・Note・FeaturedCollection のみ処理)。フォロワー一覧の同期には別機構を使うため、この配送は受信側に使われず、Firestore 読み取りとタスクキューを浪費するだけだった。

## 決定

1. **コレクション変更に伴う `Update` の配送を行わない。** フォローの承認・解除・拒否、Like や Announce に伴うコレクション更新で、フォロワーや相手へ `Update` を配送しない。
2. **apex フォークに `publishCollectionUpdates` 設定を追加し、既定値を `false` とする。** inbox / outbox の副作用ハンドラ (`net/activity.ts`)、`publishUndoUpdate`、および `acceptFollow` の `postTask` をこの設定でガードする (→ [ADR-0042](0042-apex-fork-responsibility-boundary.md))。
3. **`acceptAndPublishFollow` から `publishUpdatedFollowers` の呼び出しを削除する。** `apex.acceptFollow` の戻り値 `postTask` を実行しない。
4. **プロフィールの `Update` (actor 本体の更新) およびコレクションの GET エンドポイントは維持する。** `Update(Person)` の配送や、`/followers` などのコレクション取得 API の動作・件数は変更しない。

## 理由

- ActivityPub 仕様上、コレクション更新時の `Update(Collection)` 配送は要求されていない。Mastodon 等のリモートサーバーもこれを無視するため、配送する利益がない。
- フォーク側に設定フラグ (`publishCollectionUpdates: false`) を設けることで、フォークの汎用性を損なわずに既定値で無駄な配送を抑止できる。
- 引っ越し時の $O(N^2)$ 配送爆発と Firestore 読み取りを排除し、`Accept` を即座に配送できる。

## 結果

- Follow を承認した際に積まれる配送タスクが `Accept` の 1 件のみになる。
- 受信した `Undo(Follow)` や `Reject` で不要な `Update` が配送されなくなる。

## 参照

- [[0003-delivery-via-cloud-tasks]]、[[0042-apex-fork-responsibility-boundary]]、[[0111-retry-unaccepted-follow-and-500-on-sync-failure]]
- 関連 Issue: [#259](https://github.com/hakatashi/activitypub-firebase/issues/259)
