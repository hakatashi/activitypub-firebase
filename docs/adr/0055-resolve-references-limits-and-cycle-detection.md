# ADR-0055: `resolveReferences` での循環参照検出・探索数制限・タグ再帰抑止

- **Status:** Accepted
- **Date:** 2026-10-01

## 背景

apex の `resolveReferences` は受信アクティビティのスレッドや参照 (`inReplyTo`, `object`, `target`, `tag`) を
再帰的に解決するが、訪問管理 (`visited`) がなく、Hashtag の `href` も取得対象になっていた。
Cloud Functions ではレスポンス後に CPU が停止するため受信処理中に同期解決する必要があるが、
多数の異なる URL やタグを持つ悪意あるアクティビティにより、増幅攻撃やタイムアウトを招く危険があった。

## 決定

- **同期解決の維持**: サーバレス実行環境と apex の責務境界 ([ADR-0042](0042-apex-fork-responsibility-boundary.md)) に従い、
  レスポンス前の同期解決を維持しつつ、探索範囲を厳格に制限する。
- **訪問管理 (`visited: Set<string>`)**: 処理済みの IRI / ID を追跡し、循環参照や重複フェッチを抑止する。
- **解決総数上限 (`threadLimit`)**: 1回あたりの最大解決オブジェクト数を既定 10 件に制限し、超過時は探索を終了する。
- **並行度制限 (`threadConcurrency`)**: 参照解決時の非同期フェッチ並行数を既定 2 に制限する。
- **再帰深さ (`threadDepth`) の引き下げ**: 既定値を 10 から 5 に引き下げる。
- **`tag` の制御**:
  - `Hashtag` は AP オブジェクトではないため解決対象から除外する。
  - `depth > 0` の再帰探索では `tag` を対象から外し、スレッド関係 (`inReplyTo`, `object`, `target`) のみを辿る。

## 理由

- 外部タスク化は apex フォークの自律性を損ない、未完了時の受信応答はフォワーディング漏れを生む。
- 10 件制限・2 並行・タイムアウト 5 秒により、最悪ケースでも 25 秒以内に完了し 60 秒タイムアウトを防げる。
- タグの再帰はスレッド解決の本質ではなく、Hashtag は HTML ページを返すため取得自体が無駄かつ危険。

## 結果

- 循環参照やタグ大量埋め込みによる DoS / 増幅攻撃・ソケット枯渇・関数タイムアウトを確実に防止できる。
- 正常なスレッドのフォワーディング判定は 5 階層・10 件の範囲で十分に機能する。

## 参照

- 関連 Issue: [#138](https://github.com/hakatashi/activitypub-firebase/issues/138)
- 関連 ADR: [[ADR-0013]], [[ADR-0042]], [[ADR-0050]]
- 関連コード: `functions/src/apex/pub/federation.ts`, `functions/src/apex/pub/object.ts`
