# ADR-0126: Mastodon アーカイブから投稿履歴を配送せずにインポートする

- **Status:** Accepted
- **Date:** 2026-10-13

## 背景

Issue #268。pawoo.net からの移行にあたり、アーカイブ (`outbox.json`) の投稿履歴 (約6,900件) を
**配送せずに**インポートし、Elk / Phanpy で過去ログを読めるようにしたい。外部インスタンスへの再配送を
防ぎつつ、公開範囲・スレッド・Mastodon ID・ハッシュタグなどの整合性を保つ必要がある。

## 決定

1. **IRI と ID:** 新ドメインで振り直す (`https://<domain>/activitypub/o/<id>`)。旧 status ID を
   オブジェクト ID としてそのまま使い、旧 URI から決定論的に新 IRI を解決する。
   自リプライ (`inReplyTo`) は新 IRI に繋ぎ直す。旧 URI は `_meta.legacyUri` に残す。
   Mastodon ID は対象の `published` に基づき `Store` が採番する (ADR-0058)。
2. **`attributedTo` と宛先:** `attributedTo` はローカル actor に書き換える。`to` / `cc` の
   旧フォロワー IRI (`https://pawoo.net/.../followers`) をローカル actor のフォロワー IRI に置換し、
   `as:Public` は維持する。これにより公開範囲 (ADR-0060) が維持される。
3. **取り込み対象:** 全公開範囲 (public, unlisted, private, direct) の Note を取り込む。
   ブースト (`Announce`) はリモート取得の依存や失敗を避けるためスキップする。
4. **配送の完全抑止:** 保存は `Store#saveObject` と、Create アクティビティに outbox コレクションを付与した
   `Store#saveActivity` を直接呼ぶ。`apex.addToOutbox` / `publishActivity` / `deliveryEnqueue` は
   呼ばない。`onStreamCreated` により `statuses_count` は正しく増える。
5. **本文・タグ・添付メディア:** 本文 HTML と `tag` はそのまま保存し、ハッシュタグ検索に対応させる (ADR-0103)。
   添付メディアはアーカイブ内の相対パスのまま保存し、Cloud Storage への転送は別 Issue で行う。
6. **冪等性とレート制御:** 既存オブジェクトが存在すればスキップし、安全に再実行可能にする。
   Firestore の制限やトリガー急増を防ぐため、並行度 (concurrency) を制御して書き込む。

## 理由

- 新ドメインで振り直すことでローカルオブジェクトとして自然に扱え、pawoo.net 停止時も安全になる。
  旧 status ID を流用することで自リプライのスレッド結合が外部参照なしに決定論的に行える。
- 配送経路を通さずに Store に直接書き込むことで、外部フォロワーへ過去ログを流すことなく outbox と投稿数を揃えられる。

## 参照

- 関連 ADR: [[ADR-0003]], [[ADR-0058]], [[ADR-0060]], [[ADR-0086]], [[ADR-0102]], [[ADR-0103]]
- 関連 Issue: #268
