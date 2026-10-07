# ADR-0094: メディアアップロード API の独立 Function 分離と mastodonApi の軽量化

- **Status:** Accepted
- **Supersedes:** [[ADR-0093]]
- **Date:** 2026-10-08

## 背景

ADR-0093 では画像処理 (sharp) の OOM 対策として `mastodonApi` 全体を 2GiB に引き上げた。
しかし、利用頻度の低いメディアアップロードのために通常 API (タイムライン、通知、アカウント等) を含む全コンテナに 2GiB を常時プロビジョニングすることは非効率であり、画像処理の負荷や万が一の OOM が通常 API に波及する懸念 (障害分離の欠如) がある。
通常 API を 256MiB の軽量構成に保ちつつ、画像アップロード時のみ大容量リソースを活用する構成が必要である。

## 決定

- **メディア専用 Function の新設:** メディアのアップロード・取得・編集 (`/api/v1/media*`, `/api/v2/media*`) を専用の Cloud Function `mediaUploadApi` (2GiB / 1.0 vCPU、大容量転送を考慮し `timeoutSeconds: 120`) として分離する。
- **mastodonApi の軽量化:** `mastodonApi` の割り当てメモリを 256MiB (`memory: '256MiB'`) に戻し、`mediaRouter` をマウントから除外する。
- **Firebase Hosting によるルーティング:** `firebase.json` の rewrites で、`/api/v1/media`、`/api/v1/media/**`、`/api/v2/media`、`/api/v2/media/**` を `mediaUploadApi` へ、その他の `/api/**` を `mastodonApi` へ振り分ける。
- **sharp 設定の維持:** ADR-0093 で導入した `sharp.cache(false)` および `sharp.concurrency(1)` は `mediaUploadApi` 内でも引き続き適用する。

## 理由

- Firebase Hosting のパス別 rewrite により、クライアント側からは同一ドメイン (`mastodon.hakatashi.com`) かつ同期 200 OK の完全互換性を保ったまま、コンテナのスペックをエンドポイント単位で分離できる。
- 障害分離 (Fault Isolation) が実現され、メディアアップロードで高負荷やメモリ急増が発生しても、通常のタイムライン閲覧や投稿は一切巻き添えにならない。
- `mastodonApi` から sharp への依存が排除され、コンテナ起動速度とメモリ効率が最大化される。

## 参照

- 関連 Issue: #218, #219
- 関連 ADR: [[ADR-0091]], [[ADR-0092]], [[ADR-0093]]
