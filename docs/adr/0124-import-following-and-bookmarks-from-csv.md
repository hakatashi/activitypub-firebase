# ADR-0124: Mastodon エクスポート CSV からのフォローとブックマークのインポート

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

pawoo.net からの引っ越し (Phase 5) では、Mastodon の Moving 機能によりフォロー・ブックマークが
自動移行されない。pawoo.net のエクスポート CSV (`following_accounts.csv`, `bookmarks.csv`) を読み、
ローカル actor で再登録する仕組みが必要となる。約 300 件のアカウントを安全に移行する必要がある。

## 決定

**`functions/bin/importFollowing.ts` と `functions/bin/importBookmarks.ts` の CLI スクリプトとして実装し、
射影に基づく冪等性と間隔調整を備えたインポートを行う。**

1. **実行形態:** 長時間実行と対話的確認のため、管理者エンドポイントではなく CLI スクリプトとする。`--dry-run` に対応する。
2. **ドメイン層への集約:** フォロー処理 (Follow 生成・outbox 登録・公開化) は `social/follows.ts` の `followActor` に集約し、API と共有する (ADR-0080)。
3. **冪等性:** 射影 (`following` / `requested`) を確認し、フォロー済み・承認待ちはスキップする。ブックマークも登録済みはスキップする。途中で中断しても安全に再実行できる。
4. **送信レート:** pawoo.net 等の外部サーバーへの集中を避けるため、1件ごとに一定の間隔 (デフォルト 1000ms) を空けて実行する。
5. **引っ越し済みアカウント (`movedTo`):** 旧アカウントへの Follow は行わず、スキップして引っ越し先 URI とともにサマリーに出力する。自動追従による誤フォローや二重フォローを防ぐ。
6. **未対応フィールド:** CSV の `Show boosts` / `Notify on new posts` / `Languages` は機能がないため読み捨てる。
7. **失敗の扱い:** 解決失敗 (サーバー停止・削除済み等) はスキップし、最後に一覧としてサマリー出力する。秘密情報はログに出さない。

## 理由

- 300 件前後の外部解決と配送キュー投入は Cloud Functions の実行時間上限を圧迫しやすいため、CLI の方が安全。
- 射影の `following` / `requested` を判定することで、再実行時の二重送信を確実に防げる。
- `movedTo` の自動追従は重複フォローや意図しないアカウントへの追従の危険があるため、ユーザーへの報告に留める。

## 結果

- pawoo.net からのフォロー・ブックマークを安全かつ冪等に dev / 本番へインポートできる。

## 参照

- 関連 Issue: [#266](https://github.com/hakatashi/activitypub-firebase/issues/266), [#10](https://github.com/hakatashi/activitypub-firebase/issues/10)
- 関連 ADR: [ADR-0080](0080-social-domain-layer-and-dependency-direction.md), [ADR-0082](0082-project-follow-relations-in-store.md), [ADR-0083](0083-read-follow-relations-from-projection.md), [ADR-0097](0097-search-and-resolve-remote-resources.md), [ADR-0100](0100-cursor-for-favourites-and-bookmarks.md)
