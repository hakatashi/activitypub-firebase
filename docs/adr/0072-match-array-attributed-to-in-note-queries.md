# ADR-0072: Note の投稿者検索は配列形式の `attributedTo` にも一致させる

- **Status:** Accepted
- **Date:** 2026-10-05

## 背景

Issue #65 の確認で、フォロー中のリモートアカウントの投稿がホームタイムラインにも
`accounts/:id/statuses` にも一切出ないことが分かった。
ローカルの Note は `attributedTo` を文字列で保存するが、inbox で受け取ったリモートの Note は
apex の validator が `attributedTo = [actor.id]` と**配列**に正規化してから保存する。
`ApexStore.getNotes` は `where('attributedTo', 'in', actors)` で引いており ([[ADR-0061]])、
`in` は値の完全一致なので配列で保存された Note に一致しない。

## 決定

- `getNotes` は [[ADR-0064]] の `inReplyTo` と同じく、`Filter.or` で
  `attributedTo in actors`(文字列)と `attributedTo array-contains-any actors`(配列)の両方を引く。
- 保存形式はどちらにも揃えない(既存データの書き換えとバックフィルを不要にするため)。
- OR 条件は選言標準形で `in` と `array-contains-any` の要素数の和が選言数になり、
  Firestore の上限は 30 なので、1クエリに渡す actor は 15 件 (`NOTE_AUTHORS_QUERY_LIMIT`) までとする。
- `objects` に `(type, attributedTo CONTAINS, _meta.published ASC/DESC)` の複合インデックスを追加する。

## 理由

- 保存形式を文字列に揃える案は、apex フォーク側の validator と既存データの両方を直す必要があり、
  [[ADR-0064]] で同種の問題をクエリ側で吸収した前例と食い違う。
- ホームタイムラインの actor 数はフォロー数 + 1 で、チャンク数が倍になっても実害はない。

## 結果

- リモートの Note がホームタイムラインとアカウントの投稿一覧に出るようになる。
- `attributedTo` で Note を引く箇所を新たに作るときは、両方の形式を考慮する必要がある。
