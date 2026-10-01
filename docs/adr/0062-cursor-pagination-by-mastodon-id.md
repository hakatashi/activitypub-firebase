# ADR-0062: ページネーションは Mastodon ID のカーソルで行い、Firestore は published で範囲を絞る

- **Status:** Accepted
- **Date:** 2026-10-02

## 背景

コレクション系エンドポイントが全件か先頭 N 件しか返せなかった (Issue #59)。Mastodon API は
`max_id` / `since_id` / `min_id` / `limit` と `Link` ヘッダでページングする (→ ADR-0006)。

## 決定

- 解釈と `Link` 生成は Firestore に触らない純粋関数として `functions/src/mastodon/pagination.ts` に置く。
  ID は 20 桁ゼロ埋めの 10 進数なので、文字列の辞書順比較がそのまま大小比較になる (→ ADR-0058)。
  形式が不正な ID は無視する。`limit` は範囲外なら clamp する (statuses: 既定 20 / 最大 40、followers: 既定 40 / 最大 80)。
- 方向: `max_id` は ID が小さい側へ、`since_id` は新しい側から埋める (間が抜けてよい)、
  `min_id` はカーソルに隣接する古い側から埋める。**応答の並びは常に新しい順。**
- `Link` は `next` = `max_id=<最古の ID>`、`prev` = `min_id=<最新の ID>`。結果が空なら出さない。
  `limit` など他のクエリは引き継ぐ。`Access-Control-Expose-Headers: Link` を付ける。
- Firestore へは、ID のタイムスタンプ部から求めた `_meta.published` の範囲で絞り、取得後に ID で厳密に比較する。
  同一ミリ秒内の順序は ID のシーケンスで決まるため、最終的な並べ替えも ID で行う。
- AP の `published` はクエリに使わない。apex の `fromJSONLD` は `compactArrays: false` で
  プロパティを配列に展開するため (意図的な設計)、受信した外部オブジェクトでは `published: ['…']` になる。
  Firestore は型ごとに比較するので、配列値は範囲指定から落ち、並び順も狂う (dev で実際にページが欠けた)。
  AP オブジェクトは書き換えず、`_meta.published` に並べ替えキーを持つ (`toPublishedSortKey`)。
  ミリ秒つき ISO 8601 (UTC) で、ID のタイムスタンプと同じ規則 (未来は現在時刻に丸める → ADR-0058) で決めるため、
  ID の大小と同じ順序になる。`_meta.index.*` と同じ非正規化の流儀 (→ ADR-0021)。
  `saveObject` / `updateObject` が書き込み、既存分は `functions/bin/backfillPublishedMeta.ts` で入れる。
- `/accounts/:id/followers` のカーソルは Follow アクティビティの Mastodon ID とする (Mastodon の follow 行 ID に相当)。
  アカウント ID はリモートで共通のプレースホルダなので使えない。
- 複合インデックスは `type + _meta.published` と `type + attributedTo + _meta.published` を昇順・降順の両方で作る
  (`min_id` は昇順で読む。降順のものは昇順クエリに使われず、dev で `FAILED_PRECONDITION` になった)。
- 可視性で落ちる分の読み足しは、1回 100 件以上 (limit の3倍と比較して大きい方) 読む。小さい limit で
  非公開投稿が続くと、読み足しの上限で空ページになりカーソルが途切れるため。
