# ADR-0134: リストは `userInfos/{actor}/lists` に直接保存し、リストのタイムラインは読み出し時に絞り込む

- **Status:** Accepted
- **Date:** 2026-10-21

## 背景

Mastodon API のリスト機能(#306)を実装する。リストは AP に対応物のないローカルだけのデータで、
連合には関わらない。Mastodon はリストのタイムラインを、投稿の受信時にリストごとのフィードへ
書き込む(fan-out)方式で作る。また、pawoo.net からエクスポートしたリストの CSV(`lists.csv`、
ヘッダなしの `リスト名,acct`)を取り込みたい。

## 決定

1. **保存:** リストを `userInfos/{actor}/lists/{リスト ID}` に1件1ドキュメントで保存する。
   タイトル・`replies_policy`・`exclusive` とメンバーの actor IRI の配列を持つ。AP から導出する
   データではないため射影(ADR-0082、ADR-0088)にはせず、ブックマーク(ADR-0070)と同じく API が直接書く。
   リスト ID は作成時刻から作る Mastodon ID 形式の値で、`mastodonIds` には登録しない(ADR-0100 と同じ)。
   Mastodon と同じく1人50件・タイトル256文字までとする。
2. **メンバーの条件:** Mastodon と同じく、フォロー中・承認待ちの相手と自分だけを追加できる(それ以外は 422)。
   フォローを外してもメンバーからは消さず、タイムラインに出さないだけにする。
3. **タイムライン:** 射影を作らず、読み出し時にメンバーのうちフォロー中(承認済み)の相手と自分を
   作者としてホームタイムラインと同じ `collectTimelineItems` で集める。Note とブーストを含み、
   ページングと `Link` ヘッダもホームと揃える。
4. **`replies_policy`:** Mastodon の `FeedManager#filter_from_list?` と同じ規則で、他人への返信を絞る。
   自分への返信・セルフリプライは常に出し、それ以外は `followed` ならフォロー中の相手への返信、
   `list` ならメンバーへの返信だけを出し、`none` なら出さない。返信先の作者は返信先の Note を引いて決め、
   手元に無ければ(Mastodon の `in_reply_to_account_id` が無い場合と同じく)出さない。ブーストには適用しない。
5. **`exclusive`:** `exclusive` なリストのメンバー(自分を除く)の投稿とブーストを、ホームタイムラインの
   作者から外す。
6. **メンバー一覧のページング:** Mastodon と同じくアカウント ID の降順で並べ、アカウント ID をカーソルにする。
   ローカルのアカウント ID(`1` など)もカーソルにできるよう、桁数をそろえて比較する。
7. **CSV の取り込み:** `functions/bin/importLists.ts` の CLI とする(ADR-0124 と同じ理由)。
   Mastodon の `BulkImportRowService` と同じく、同名のリストが無ければ作り、フォローしていない相手は
   フォローしてから追加する(`--no-follow` でフォローせずに飛ばす)。引っ越し済み(`movedTo`)の相手は
   ADR-0124 と同じくフォローも追加もせずサマリーに出す。冪等で、`--dry-run` に対応する。

## 理由

- 利用者は1人で、リストもメンバーも少ない。fan-out や射影の整合性維持を足すより、ホームと同じ読み出しで足りる。
- フォロー解除時にメンバーを消す処理を射影の更新に足すより単純で、承認待ちが承認されたときも何もしなくてよい。

## 結果

- 投稿の受信・保存の経路(Store・inbox)は変わらず、連合に影響しない。
- `replies_policy` の判定のため、返信を含むページでは返信先の Note を追加で読む。

## 参照

- 関連 Issue: [#306](https://github.com/hakatashi/activitypub-firebase/issues/306) / 関連 ADR: [ADR-0070](0070-status-viewer-attributes-and-storage.md), [ADR-0096](0096-boosts-in-timelines-and-account-statuses.md), [ADR-0100](0100-cursor-for-favourites-and-bookmarks.md), [ADR-0124](0124-import-following-and-bookmarks-from-csv.md)
