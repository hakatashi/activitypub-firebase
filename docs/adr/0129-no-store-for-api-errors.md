# ADR-0129: `/api/**` のエラー応答に `Cache-Control: no-store` を付ける

- **Status:** Accepted
- **Date:** 2026-10-13

## 背景

`GET /api/v1/accounts/lookup` は手元にキャッシュ済みのリモート actor だけを返し、未解決なら 404 にする
([ADR-0073](0073-lookup-cached-remote-accounts.md))。解決は `search?resolve=true` の役割である。
Elk は `lookup` が 404 になった後で `search` を呼ぶ。

この 404 には `cache-control: max-age=600` が付き、Firebase Hosting の CDN (`x-cache: HIT` を確認) と
ブラウザが 10 分間保持する。そのため `search` でアカウントを取り込んでも、直後の `lookup` は
キャッシュされた 404 を返し、Elk のプロフィールが Not Found のままになる (Issue #302)。
Cloud Functions 側は `Cache-Control` を設定しておらず、このヘッダーは Hosting が付けている。

## 決定

- `/api/**` の 4xx / 5xx 応答には、ハンドラが `Cache-Control` を設定していない限り
  `Cache-Control: no-store` を付ける。
- 2xx 応答には手を入れない。

## 理由

- エラーは「その時点で無い」ことを示すだけで、`search` や inbox の受信で状態が変わる。
  Mastodon のクライアントはこの順序(失敗 → 解決 → 再取得)を前提にしている。
- 404 の再計算は Firestore の 1 クエリで済み、キャッシュを失うコストは小さい。
- 200 を含む全応答に付けるより影響範囲が狭い。

## 結果

- `search` で取り込んだ直後に `lookup` が引けるようになる。
- 存在しないアカウントへの `lookup` はそのたびに関数が実行される。
