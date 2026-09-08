# ADR-0042: apex フォークと本体コードの責務境界

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

[ADR-0040](0040-fork-activitypub-express.md) でフォークを自前で保守すると決めた結果、
「この修正はフォーク側に入れるのか、本体側に置くのか」を毎回判断することになる。
基準がないと、フォークが少しずつこのプロジェクト専用のコードで汚染され、
**修正がどこにあるか分からない状態(現状の裏返し)に戻る。**

## 決定

**判定基準は1つ。**

> **他人が同じライブラリを素で使ったときも、同じ修正を必要とするか?**
> Yes ならフォーク側、No なら本体側。

**フォーク側 = 「ActivityPub 仕様に対して正しいか」。相手が誰であっても答えが同じもの。**
JSON-LD 正規化とコンテキスト処理、HTTP 署名の生成・検証と鍵解決、inbox/outbox のバリデーションと
activity/object の解決、仕様が MUST とする検証、SSRF セーフな取得、Store インターフェースの契約定義。

**本体側 = 「このインスタンスがどう振る舞いたいか」。設定・運用・製品判断。**
Firestore Store 実装、Cloud Tasks 配送(→ [ADR-0003](0003-delivery-via-cloud-tasks.md))、
Mastodon 互換 API、カウントの非正規化(→ [ADR-0037](0037-denormalize-like-announce-counts.md)、
[ADR-0039](0039-scope-statuses-count-to-create.md))、ブロックリスト方針
(→ [ADR-0029](0029-blocklist-filter-in-application.md))、シングルユーザー前提の扱い。

**この基準を機械的に守るため、`functions/src/apex/` 配下から `firebase-admin` /
`firebase-functions` / 本体モジュールへの import を lint で禁止する。**

## 理由

- この基準は新しく作ったものではなく、**既存の Issue と ADR が既に使っていた言葉**である。
  Issue #52 は SSRF について「apex を素で使う全てのアプリが影響を受ける欠陥」と書いている。
  ADR-0034 は `as:Public` 認識漏れを「JSON-LD 処理としては不完全」と書いている。
  基準を明文化しただけで、判定結果は既存の分析と一致する。
- lint による強制が有効なのは、違反が**設計の誤りのシグナルとして表れる**ため。
  フォーク側から Firebase を触りたくなったら、それは「その処理は本体側の責務だ」という意味になる。
- ADR-0037 は境界がカウンタで分かれる例になっている。
  Like/Announce の **object 解決**はフォーク側(→ [ADR-0038](0038-resolve-like-announce-object-as-plain-object.md))、
  **カウントの非正規化**は本体側。同じ機能でも層で切れる。

## 結果

- 既存の回避コードの移送先はこの基準で一意に決まる。
  ADR-0030 / 0031 / 0032 / 0033 / 0034 / 0036 / 0038 はすべてフォーク側。
- フォークは Firebase に依存しないまま保たれるため、
  Firestore エミュレータなしで単体テストできる状態が維持される。
- 「本体側に置いた方が早いが基準ではフォーク側」というケースで摩擦が生じる。
  **その場合は基準を優先する。** 例外を作りたくなったら、この ADR を supersede する。

## 参照

- [[ADR-0040]], [[ADR-0041]]
- Epic [#103](https://github.com/hakatashi/activitypub-firebase/issues/103)
