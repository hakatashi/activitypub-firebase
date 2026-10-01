# ADR-0058: Mastodon ID の具体的な採番方式と IRI との相互マッピング

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

[[ADR-0006]] は Mastodon API の ID を「時系列に単調増加する固定長ゼロパディング数値文字列」とし、
Snowflake 相当を基本とすることまで決めたが、ビット幅・エポック・シーケンス・保存先は実装時に委ねた。
Cloud Functions は複数インスタンスが並行するため、プロセス内カウンタでは一意性を保証できない。

## 決定

- **レイアウトは Mastodon 本体と同じ** `UNIX エポックからのミリ秒 << 16 | シーケンス(16 bit)` とし、
  10 進数で **20 桁にゼロパディング**する(64 bit 符号なし整数の最大値が 20 桁)。
- タイムスタンプは対象の `published` を使い、**現在時刻より未来なら現在時刻に丸める**。
  `published` が無い・解釈できない場合は現在時刻を使う。新規保存時もバックフィル時も同じ規則で採番する。
- シーケンスは 0 から順に空きを探す。一意性は Firestore トランザクションで保証する。
- マッピングは2つのコレクションに**同一トランザクションで**書く。
  - `mastodonIds/{Mastodon ID}` → `{ iri }`(ID → IRI。ドキュメント ID が一意性の鍵)
  - `mastodonIdsByIri/{エスケープした IRI}` → `{ mastodonId }`(IRI → ID)
- 採番は `Store#saveObject` / `Store#saveActivity` で行い、`objects` / `streams` に新規保存される
  **すべての** IRI に振る。`POST /api/v1/statuses` も inbox もこの経路を通る。
  加えて読み出し側(`getMastodonIds`)も未採番の IRI を見つけたらその場で採番する。

## 理由

- Mastodon と同じレイアウトなら、既存クライアントが ID からおおよその時刻を推定する実装とも矛盾しない。
- 受信した過去の投稿(リプライ解決で後から取得したものなど)を受信時刻で採番すると時系列が崩れる。
  `published` 基準にすればバックフィルと新規保存で同じ順序になる。未来の `published` は
  ページネーションの先頭に居座り続けるため丸める。
- 逆引きを `_meta` に置く案は、`updateObject(..., fullReplace)` が `_meta` ごと上書きしうるため採らなかった。
  別コレクションなら AP オブジェクトの更新・Tombstone 化の影響を受けず、ID が安定する。
- Note / Activity に限定せず全 IRI に振るのは、Account・Notification でも同じ体系が必要になりうるうえ、
  型判定を採番経路に持ち込まずに済むため。

## 結果

- 同一ミリ秒の採番は最大 65,536 件。超えたら例外にする(単一ユーザー運用では現実的に起こらない)。
- 保存1回につきトランザクション内の読み書きが増える。
- 既存データは `functions/bin/assignMastodonIds.ts` でバックフィルする。

## 参照

- 関連 ADR: [[ADR-0006]], [[ADR-0053]]
- 関連コード: `functions/src/mastodonId.ts`, `functions/src/store.ts`
- `third_party/mastodon/lib/mastodon/snowflake.rb`
