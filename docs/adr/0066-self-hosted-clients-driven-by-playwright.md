# ADR-0066: クライアント互換性の検証に Elk / Phanpy を自前ホストし Playwright で操作する

- **Status:** Accepted
- **Date:** 2026-10-03

## 背景

Phase 3 のゴールは「Elk から日常的に使える」こと(#8、#65)だが、クライアントでの確認は
人がブラウザで devtools を見る手作業で、エージェントのセッションからは行えなかった。
クライアント固有の不具合(`verify_credentials` の `role` 欠落による Elk のクラッシュ、
未実装エンドポイントの 501 など)は API を curl で叩いても見つからない。
連合の検証相手を自前ホストした([ADR-0014](0014-self-hosted-federation-test-instance.md))のと同じ問題である。

## 決定

- **Elk と Phanpy を HakataMatrix 上にバージョン固定で自前ホストする。** `127.0.0.1` にのみ bind し、外部公開しない。
- **Playwright(`tools/client-e2e/`)でログインと主要画面の巡回・投稿を行い**、スクリーンショット・
  ページの例外・失敗したリクエストを出力する。エージェントはこれを読んで判断する。
- ログインは OAuth の認可画面を通さず、`.env` の `MASTODON_DEV_TOKEN` をクライアントに渡して行う。
  Elk は自身の `/signin/callback?server=&token=` を、Phanpy は localStorage の `accounts` を使う。

## 理由

- elk.zone などの公開インスタンスを使うと、dev の OAuth クライアント情報が他人のサーバーに残り、
  バージョンも勝手に変わって再現性がない。
- 相手が1実装だと「たまたま動く」を検出できない(ADR-0014 と同じ理由)。Phanpy は叩く API も、
  欠けたフィールドへの耐性も Elk と違う。静的 SPA なので運用は nginx だけで済む。
- 認可画面は FirebaseUI の Google ログインで、ヘッドレスブラウザからは通せない。
  トークンを渡す方式なら本体に dev 専用のログイン経路を作らずに済む。

## 結果

- アプリ登録 → 認可 → トークン交換の流れ(Phanpy の PKCE を含む)はこの仕組みでは検証されない。
  必要になったら、認可を自動化する手段を別の ADR で決める。
- バージョンを固定しているので、クライアントの更新は手で行う(`~/docs/mastodon-client-test.md`)。

## 参照

- 関連 Issue: [#165](https://github.com/hakatashi/activitypub-firebase/issues/165)、#65
- 手順: [`docs/runbooks/client-testing.md`](../runbooks/client-testing.md)
