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
- Firestore へは ID の範囲指定ではなく、ID のタイムスタンプ部から求めた `published` の範囲
  (±1 秒の余裕付き、形式の揺れ吸収のため) で絞り、取得後に ID で厳密に比較する。
  同一ミリ秒内の順序は ID のシーケンスで決まるため、最終的な並べ替えも ID で行う。
  未来の `published` は採番時に丸められている (→ ADR-0058) ため、その Note はカーソル付きの範囲に入らないことがある。
- `/accounts/:id/followers` のカーソルは Follow アクティビティの Mastodon ID とする (Mastodon の follow 行 ID に相当)。
  アカウント ID はリモートで共通のプレースホルダなので使えない。
- `min_id` は昇順で読むため、`type + published` と `type + attributedTo + published` の昇順の複合インデックスを追加する
  (降順のものは昇順クエリに使われず、dev で `FAILED_PRECONDITION` になった)。
- 可視性で落ちる分の読み足しは、1回 100 件以上 (limit の3倍と比較して大きい方) 読む。小さい limit で
  非公開投稿が続くと、読み足しの上限で空ページになりカーソルが途切れるため。
- `published` が1要素の文字列配列で保存されたオブジェクト (dev で実在した) は、Firestore の型ごとの比較により範囲指定から落ちて
  ページから抜ける。保存時 (`saveObject` / `updateObject`) に文字列へ畳み (`normalizePublished`)、既存分は
  `functions/bin/normalizePublished.ts` で直す。
