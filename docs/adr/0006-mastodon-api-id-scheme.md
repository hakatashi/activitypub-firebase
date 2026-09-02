# ADR-0006: Mastodon API の ID は時系列順序を持つ独自採番にする

- **Status:** Accepted
- **Date:** 2026-09-03

## 背景

Mastodon API は Status / Account / Notification などの ID を文字列で返す。API ドキュメント
(`third_party/mastodon_documentation/content/en/api/guidelines.md`)は
「ID は常に不透明な文字列として扱え」「非公式実装は数値形式でなくてもよい」と明示しており、
形式そのものに制約はない。

しかし同じドキュメントが、ページネーションを次のように定義している。

- `max_id`: 「All results returned will be **lesser than** this ID」
- `since_id`: 「All results returned will be **greater than** this ID」
- `min_id`: このIDにカーソルを置いて順方向にページングする

**つまりページネーションは ID の大小比較で成立している。** ID が時系列に単調増加でなければ、
ページングは論理的に破綻する。

現状、`functions/src/mastodon/api.ts` の `noteObjectToStatus` は Note の IRI の末尾
(= Firestore の自動生成 ID、ランダムな20文字)を Status ID として使っている。
**これはランダムなので時系列順にならず、ページネーションを実装しても正しく動かない。**

## 決定

Mastodon API で外部に露出する ID は、ActivityPub の IRI とは**別に独自採番する。**

- **時系列に単調増加すること。**
- **固定長のゼロパディングされた数値文字列にすること。** API ドキュメントが
  「1. 長さでソート 2. 辞書順でソート」という手順を提示している以上、
  長さが可変だとその手順を実装したクライアントで順序が壊れる。
- **URL セーフであること。** ID は `/api/v1/statuses/:id` のパスに直接入る。
- AP の IRI ↔ Mastodon ID の相互マッピングを Firestore に保持する。

具体的な採番方式(ビット幅・エポック・シーケンス)は実装時に決めてよいが、
Snowflake ID 相当(ミリ秒タイムスタンプ + シーケンス)を基本とする。

## 理由

**この決定は後から変更できない。** ID を変えると、クライアントが保持しているキャッシュ・
既読位置(marker)・ブックマークがすべて無効になり、外部から参照されている URL も壊れる。
したがって Mastodon API の本格実装に着手する前に確定させる必要がある。

AP の IRI をそのまま Mastodon ID に使う案も検討したが、`/` や `%` を含むため URL パスに入れられず、
また時系列順序も持たないため却下した。

## 結果

- Mastodon API を実装する際、Note / Activity を保存するタイミングで Mastodon ID を採番し、
  マッピングを永続化する必要がある。
- 既存データ(現在の dev/本番環境の Note)には Mastodon ID が振られていないため、
  バックフィルが必要になる。`functions/bin/denormalizations.ts` と同様のワンショットスクリプトを用意する。
- Mastodon アーカイブからトゥート履歴をインポートする際も、投稿日時に基づいて
  同じ体系で ID を振る(→ Phase 5)。

## 参照

- `third_party/mastodon_documentation/content/en/api/guidelines.md`(ID とページネーションの節)
- `functions/src/mastodon/api.ts` の `noteObjectToStatus`
- [[ADR-0004]] 自前 Web UI を作らず Mastodon 互換 API + Elk を使う
