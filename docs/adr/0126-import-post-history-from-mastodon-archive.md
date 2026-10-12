# ADR-0126: Mastodon アーカイブから投稿履歴を配送せずにインポートする

- **Status:** Accepted
- **Date:** 2026-10-13

## 背景

Issue #268。pawoo.net からの移行にあたり、アーカイブ (`outbox.json`) の投稿履歴 (約6,900件) を
**配送せずに**インポートし、Elk / Phanpy で過去ログを読めるようにしたい。外部インスタンスへの再配送を
防ぎつつ、公開範囲・スレッド・Mastodon ID・ハッシュタグなどの整合性を保つ必要がある。

## 決定

1. **IRI と Mastodon ID:** 新ドメインで振り直す (`Note` は `https://<domain>/activitypub/o/<id>`、
   アクティビティは `/activitypub/s/<id>`)。自リプライ (`inReplyTo`) は新 IRI に繋ぎ直し、旧 URI は
   `_meta.legacyUri` に残す。旧 status ID が Snowflake 形式 (`id >> 16` が `published` と一致) の場合は
   ミリ秒精度の `published` を復元し、下位 16 bit をシーケンス起点 (`sequenceStartOf`) に使うことで、
   20 桁ゼロパディングの Mastodon ID (`00<旧 status ID>`) を旧 status ID と数値として一致させる
   (初期の非 Snowflake 連番 ID は `published` と SHA-256 起点で採番する)。
2. **`attributedTo` と宛先:** `attributedTo` / `actor` はローカル actor に書き換える。`to` / `cc` の
   旧フォロワー IRI (`https://pawoo.net/.../followers`) をローカル actor のフォロワー IRI に置換し、
   `as:Public` は維持する。これにより公開範囲 (ADR-0060) が維持される。
3. **取り込み対象 (`Create` と `Announce`):** 全公開範囲 (public, unlisted, private, direct) の Note を取り込む。
   ブースト (`Announce`) も対象 Note を `resolveUrl` で解決して `objects` に保存した上で取り込む。
4. **配送の完全抑止:** 保存は `Store#saveObject` と、outbox コレクションを付与した `Store#saveActivity` を
   直接呼ぶ。`apex.addToOutbox` / `publishActivity` / `deliveryEnqueue` は呼ばない。
   `onStreamCreated` と Store の射影更新により `statuses_count` や `reblogs` 射影は正しく更新される。
5. **本文・タグ・添付メディア:** 本文 HTML と `tag` はそのまま保存し、ハッシュタグ検索に対応させる (ADR-0103)。
   添付メディアはアーカイブ内の相対パスのまま保存し、Cloud Storage への転送は別 Issue で行う。
6. **冪等性とレート制御:** 既存オブジェクト / アクティビティが存在すればスキップし、安全に再実行可能にする。
   Firestore 制限やリモート取得負荷を抑えるため、並行度制御とリモート解決の直列化を行う。

## 理由

- 旧 Snowflake ID からミリ秒とシーケンスを引き継ぐことで、既存の20桁 ID 体系とページネーションを崩さずに旧 status ID との数値一致と正確なミリ秒順序を保てる。
- 配送経路を通さずに Store に直接書き込むことで、外部へ過去ログやブースト通知を再送することなく履歴と射影を揃えられる。

## 参照

- 関連 ADR: [[ADR-0003]], [[ADR-0058]], [[ADR-0060]], [[ADR-0084]], [[ADR-0095]], [[ADR-0096]], [[ADR-0103]], [[ADR-0118]]
- 関連 Issue: #268
