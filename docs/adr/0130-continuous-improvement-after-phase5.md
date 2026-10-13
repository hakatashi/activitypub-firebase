# ADR-0130: Phase 5 の完了後はフェーズを切らず、継続的な機能改善として Issue を管理する

- **Status:** Accepted
- **Date:** 2026-10-13

## 背景

ロードマップ(`docs/roadmap.md`)の最終目的4つは、Phase 5(pawoo.net からの引っ越し)の完了で
すべて達成される。これまでのフェーズは「配送が動かなければ他の何も意味がない」「引っ越しは
やり直せない」といった強い順序制約があったため、Epic と Milestone で束ねて順に進めてきた。

Phase 5 の後に残るのは、受信した `Move` への追従(Phase 5 のスコープ外)や Mastodon API の
未実装機能(リストなど)のような、互いに独立した改善である。これらには
フェーズで縛るほどの順序制約がなく、フェーズの区切りや「着手時に子 Issue を作る」ルールは
起票を遅らせるだけになる。

## 決定

- **Phase 5 をこのプロジェクトの最後のフェーズとし、完了をもって一区切りとする。**
  以後は新しいフェーズ・Epic Issue・フェーズの Milestone を作らない。
- Phase 5 の完了時に、Phase 0〜5 の Milestone と Epic Issue をすべて close する。
- 継続改善の Issue は**思いついた時点で起票してよい**(Phase 5 の完了前でもよい)。
  - `phase:*` ラベル・Milestone・Epic の sub-issue は付けない。
  - `area:*` と、種別として `enhancement` / `bug` を付ける。着手前に ADR が必要なら `needs-adr` を付ける。
  - 依存関係がある場合だけ GitHub の blocked by / blocking を設定する。
- 優先順位は Issue 単位で都度判断する。ただし**連合を壊さないこと(配送・受信・WebFinger)を
  機能追加より常に優先する。**
- ADR・runbook・検証(dev へのデプロイ、連合・クライアントの確認)・PR のルールは変えない。

## 結果

- `docs/roadmap.md` のフェーズ表は Phase 5 で終わり、以後の作業はオープンな Issue の一覧
  (`phase:*` ラベルのないもの)が代わりを担う。
- Phase 5 の完了前に起票された継続改善の Issue は、`phase:*` ラベルの有無で Phase 5 の Issue と区別できる。
- 大きな機能で複数の Issue を束ねたくなった場合は、その機能単位の親 Issue に sub-issue を
  ぶら下げてよい(フェーズの Epic とは扱わない)。
