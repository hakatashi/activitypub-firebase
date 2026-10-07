# ADR-0093: メディアアップロード API の独立 Function 分離とリソース設計

- **Status:** Accepted
- **Date:** 2026-10-08

## 背景

スマートフォン写真 (最大 10MB / 16MP) のアップロード時、sharp によるデコード・リサイズ・EXIF 除去・Blurhash 計算や各種バッファの同時展開によりピークメモリが 200MB を超過し、256MiB では OOM が発生した。
しかし利用頻度の低いメディア処理のために通常 API (`mastodonApi`) 全体を 2GiB に引き上げることは非効率であり、画像処理の高負荷や OOM が通常 API に波及する障害分離の欠如が懸念された。

## 決定

- **メディア専用 Function の新設:** メディア系 API (`/api/v1/media*`, `/api/v2/media*`) を専用 Cloud Function `mediaUploadApi` (2GiB / 1.0 vCPU, `timeoutSeconds: 120`) として分離する。
- **mastodonApi の軽量維持:** `mastodonApi` は 256MiB のまま維持し、`mediaRouter` を除外して sharp 依存を排除する。
- **Firebase Hosting によるルーティング:** `firebase.json` の rewrites でメディア系エンドポイントを `mediaUploadApi` へ、その他を `mastodonApi` へ振り分ける。
- **sharp 最適化:** `sharp.cache(false)` および `sharp.concurrency(1)` を適用する。

## 理由

- **障害分離と透過性:** 画像処理の高負荷やクラッシュが通常 API に波及せず、Hosting rewrite によりクライアント (Tusky, Elk 等) からは同一オリジン・完全互換に見える。
- **2GiB / 1.0 vCPU の選定:** 12MP〜16MP の非圧縮展開 (約 48MB) や各種バッファを合算したピークメモリ (150〜250MB) に対する安全マージンを確保する。1.0 vCPU により画像処理が約 250ms で完了する。呼び出し頻度が低いため月間無料枠に収まり、追加コストは実質 $0 である。
- **タイムアウト 120 秒の選定:** サーバー処理自体は数秒で完了するが、電波の不安定なモバイル回線からの大容量アップロード転送に余裕を持たせる。
- **sharp 最適化:** サーバーレス環境でのワーカースレッドによるメモリプール膨張とキャッシュ滞留を防ぐ。

## 参照

- 関連 Issue: #218, #219
- 関連 ADR: [[ADR-0091]], [[ADR-0092]]
