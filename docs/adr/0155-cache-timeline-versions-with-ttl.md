# ADR-0155: タイムラインのキャッシュの検証に使うバージョンを、数分だけインスタンス内に覚える

- **Status:** Accepted
- **Date:** 2026-10-23
- **Supersedes:** [ADR-0139](0139-cache-timeline-head-page-in-instance.md) の検証 (決定2) と [ADR-0147](0147-cache-timeline-max-id-pages-in-instance.md) の検証 (決定2) のうち、バージョンを毎回読む部分

## 背景

Issue #357。ADR-0139・ADR-0147 のキャッシュが効いた回でも、マーカー・following のバージョン・閲覧者のバージョンの
3 件を `getAll` で毎回読んでいる。15 秒ごとのポーリングの読み取りの大半がこの検証で、まだ無料枠を超えている。

## 決定

1. **覚えるもの:** 閲覧者ごとに、3 件の `updateTime` をドキュメントごとに読んだ時刻とともにインスタンスのメモリに置く。
   期限の切れたものだけを `getAll` で読み直す。
2. **TTL:** マーカーと following は 3 分、閲覧者のバージョンは 1 分。
3. **同じインスタンスでの無効化:** `touchTimelineViewVersion` (`touchesTimelineView` ミドルウェアなど) は、書き込みが
   済んでから、その閲覧者の 3 件をすべて捨てる。Mastodon API のフォロー・フォロー解除もこのミドルウェアを通るので、
   following も同じインスタンスではすぐ読み直す。捨てる前に読み始めた読み取りの結果は覚えない (世代の番号で判定する)。
4. **新着 (最新のエントリ 1 件):** 従来どおりリクエストごとに読む。キャッシュしない。

## 理由

- マーカーはバックフィルや手作業でしか変わらない。following は Mastodon API の操作なら決定3ですぐ反映し、
  遅れるのは inbox からの `Accept` / `Reject` (別の関数 `activitypub` が書く) だけで、数分の遅れは許せる。
- 閲覧者のバージョンを短くするのは、同じインスタンスで捨てられない書き込みがあるため:
  別の `mastodonApi` のインスタンスに届いた操作、Hosting の rewrite で `mediaUploadApi` に回る `update_credentials`、
  タスクで付くリンクカード (ADR-0143 決定6)。これらの直後には、他のインスタンスで最大 1 分、古い Status
  (`favourited: false` など) が返りうる。利用者は 1 人で、ふだんは 1 インスタンスで足りるので、この窓は許す。
  閲覧者のバージョンだけを毎分読んでも、3 件を 3 分ごとに読むのと比べた節約の差は小さい (ポーリング 1 回あたり約 0.17 件)。
- 新着の検出はタイムラインを読み直す意義そのもので、1 台のクライアントが各カラムを 15 秒ごとに取りに来る使い方では
  15 秒のキャッシュはほとんど当たらない。

## 結果

- 15 秒ごとのポーリングでは、検証の読み取りが 1 回あたり 3 件から約 0.42 件になる。
- 別の関数・別のインスタンスでの following の変化は最大 3 分、閲覧者の操作は最大 1 分遅れて反映する。
  フォローを外された相手の非公開の投稿も、この間はキャッシュから見えうる。
- 通知のポーリングはこのキャッシュを通らないので変わらない。

## 参照

- 関連 Issue: [#357](https://github.com/hakatashi/activitypub-firebase/issues/357) / 関連 ADR: [ADR-0135](0135-cache-following-by-projection-version.md), [ADR-0136](0136-fan-out-home-and-list-timelines-on-write.md), [ADR-0139](0139-cache-timeline-head-page-in-instance.md), [ADR-0147](0147-cache-timeline-max-id-pages-in-instance.md)
