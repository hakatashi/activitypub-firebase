# ADR-0005: 運用はシングルユーザー、データモデルはマルチユーザー対応を保つ

- **Status:** Accepted
- **Date:** 2026-09-03

## 背景

このインスタンスのユーザーは `@hakatashi@hakatashi.com` の1人だけであり、今後もそのままの想定である。
一方、現状の実装は「シングルユーザーだから」という理由で正しくない近道をしている箇所がある。
たとえば `functions/src/mastodon/api.ts` の `getAllNotes()` は、リクエストされたアカウントや
タイムラインの種類にかかわらず**全ての Note を無条件に返す**。

これは単に手抜きというだけでなく、**公開範囲(visibility)の判定が存在しない**ことを意味する。
将来 unlisted / followers-only / direct な投稿を扱うようになると、非公開の投稿が
公開タイムラインに漏れる。

## 決定

- **運用・認証・オンボーディングはシングルユーザー前提のままでよい。**
  複数アカウントの登録機能や管理画面は作らない。`beforeUserCreate` による
  `hakatasiloving@gmail.com` のみ許可する制限も維持する。
- **一方、データアクセスは常に actor を意識して書く。** タイムラインやアカウント別の投稿一覧を返す
  クエリは actor ID で絞り、**公開範囲の判定を必ず行う。**
- アカウント固定のハードコード(`functions/src/mastodon/index.ts` の actorId など)は、
  値としては1つのままでよいが、コードのインターフェースは actor を引数に取る形にする。

## 理由

「完全にシングルユーザーで割り切る」と visibility の概念ごと捨てることになり、
Mastodon クライアントから非公開投稿をした際に情報漏洩する。これは後から直すのが難しく、
かつ一度漏れたら取り返しがつかない。

逆に「完全なマルチユーザー対応」(複数アカウント登録・管理・認証)は目的に対して過剰であり、
実装量に見合わない。

actor を引数に取るだけならコストはほとんどかからず、正しさは手に入る。

## 結果

- タイムライン系エンドポイントの実装では、actor フィルタと visibility 判定が完了条件に含まれる。
- `userInfos` コレクションや `UserInfo` 型は複数ドキュメントを前提に扱う(既にそうなっている)。
- 複数アカウントの登録 UI・API は実装しない。必要になったら別 ADR で扱う。

## 参照

- `functions/src/mastodon/api.ts` の `getAllNotes()`
- `functions/src/mastodon/index.ts` の `beforeUserCreate`
- [`docs/known-issues.md`](../known-issues.md)
