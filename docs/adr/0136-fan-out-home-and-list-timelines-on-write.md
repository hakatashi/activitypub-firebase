# ADR-0136: ホーム・リストのタイムラインを書き込み時に射影し(fan-out on write)、読み出し時に検証する

- **Status:** Accepted(ADR-0134 の決定 3 を Supersede)
- **Date:** 2026-10-21

## 背景

Issue #343。ホームとリストのタイムラインは、作者を 30 人ずつに分けて `objects` / `streams` を読み、
可視性で絞ってから Mastodon ID を引いている。フォロー 280 人で先頭ページ 1 回あたりホーム約 4,500 回・
リスト約 550 回の読み取りになり、自動更新するクライアントを開いたままにすると月に数億回になる。

## 決定

1. **射影の形:** ホームは `userInfos/{actor}/homeFeed/{Mastodon ID}`、リストは
   `userInfos/{actor}/lists/{リスト ID}/feed/{Mastodon ID}` に1件1ドキュメントで持つ。ドキュメント ID は
   Note / Announce の Mastodon ID(ADR-0006)で、フィールドは `type`(`note` / `announce`)・`iri`・
   `actor`(作者・ブーストした人)・`objectIri`(ブースト先)・`createdAt`。本体は写さず、読み出し時に `getAll` で引く。
2. **書き込みの経路:** `Store#saveObject` が Note を新規に保存するとき、`Store#saveActivity` が Announce を
   新規に保存するとき(ADR-0082 の射影の仕組み)に、同じトランザクションで書く。作者がローカル actor か、
   following の射影(承認待ちを含む)にあればホームへ、作者をメンバーに含むリストへ書く。
   書き込み先の判定に使う following とリストはトランザクションの外で読み、受信のトランザクションにロックを足さない。
   射影の準備で例外が起きてもログに残して射影を諦め、Note / Announce の保存(受信)は落とさない。
3. **読み出し時の検証:** 射影は「候補」とし、読み出し時に今の方式と同じ判定をすべてやり直す。
   作者が自分か承認済みのフォロー中か(リストはさらにメンバーか)、ホームは `exclusive` なリストのメンバーでないか、
   可視性、ブースト先の存在と可視性、リストの `replies_policy`(ADR-0134 決定 4)、重複ブースト(ADR-0096)。
   したがって、フォロー解除・リストからの削除・exclusive への変更・削除(Tombstone)・ブーストの Undo では
   射影を消さない。読み出しで落ちる分だけ読み足す。
4. **フォロー・リストへの追加時:** Mastodon の `merge_into_home` / `merge_into_list` と同じく、その相手の
   最新の Note と Announce を各 200 件まで射影へ入れる。`followActor`(承認待ちの時点)と
   `addListAccounts` の後で行い、inbox の経路には入れない。リストを消したら射影も消す。
5. **戻す手段:** `userInfos/{actor}/projectionVersions/timelineFeeds` がある間だけ射影から読み、無ければ
   従来の読み出し方式を使う。バックフィル(`functions/bin/backfillTimelineFeeds.ts`)が射影を作り直してから
   これを書く。射影が壊れたらこのドキュメントを消せば従来の方式に戻る。書き込み時の射影はこれに関わらず常に行う。

## 理由

- 判定を読み出し時にやり直すので、射影の書き込みはフォロー・リスト・可視性の変化を追わなくてよく、
  正しさは従来の方式と同じになる。フォロー解除などで残る候補は読み飛ばすだけで、1件あたり数回の読み取りで済む。
- ドキュメント ID を Mastodon ID にするので、範囲指定もページングも ID だけで済み、`mastodonIdsByIri` を引かない。

## 結果

- 新着の無い先頭ページの読み取りは、ホームで約 4,500 回から 100 回前後になる(PR の見積もりを参照)。
- 受信した Note の保存に following の射影 1 件(とリストのクエリ)の読み取りと、ホーム・リストへの書き込みが増える。
- 本番では、バックフィルを実行するまで従来の方式のまま動く。

## 参照

- 関連 Issue: [#343](https://github.com/hakatashi/activitypub-firebase/issues/343) / 関連 ADR: [ADR-0061](0061-timeline-actor-filter-and-visibility.md), [ADR-0082](0082-project-follow-relations-in-store.md), [ADR-0096](0096-boosts-in-timelines-and-account-statuses.md), [ADR-0134](0134-lists-stored-per-user-and-filtered-on-read.md), [ADR-0135](0135-cache-following-by-projection-version.md)
- Mastodon の `FeedManager`(`third_party/mastodon/app/lib/feed_manager.rb`)
