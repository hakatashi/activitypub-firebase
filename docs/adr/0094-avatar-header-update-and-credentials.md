# ADR-0094: アバター・ヘッダー画像の変更とプロフィール管理

- **Status:** Accepted
- **Date:** 2026-10-08

## 背景

クライアントからのアバター・ヘッダー画像変更 (`PATCH /api/v1/accounts/update_credentials`)
および削除 (`DELETE /api/v1/profile/avatar`, `DELETE /api/v1/profile/header`)
に対応し、プロフィール画像を自前配信しつつ連合先へ `Update(Person)` を配送する必要がある (Issue #220)。
画像処理負荷の分離、Storage 保存先、古い画像の後始末方針を決定する。

## 決定

- **保存先と URL:** アバター・ヘッダー画像は Cloud Storage の `accounts/avatars/${id}.${ext}`
  および `accounts/headers/${id}.${ext}` に保存し、`makePublic()` で公開オブジェクト URL とする。
  投稿添付の未紐付けクリーンアップ (ADR-0092) の対象外とするため `mediaAttachments` コレクションには含めず、
  Actor オブジェクト (`icon`, `image`) 自体で URL を管理する。
- **画像加工と制限:** 画像形式は `image/jpeg`, `image/png`, `image/gif`, `image/webp` を受け入れ、
  位置情報等の EXIF は完全に除去する。アバターは 400×400 (中央正方形クロップ)、ヘッダーは 1500×500 以内に縮小する。
  静止画として保存し、`avatar_static` / `header_static` は通常 URL と同値とする。
- **Function 分離:** 画像アップロードを伴う `PATCH /api/v1/accounts/update_credentials` は
  Hosting rewrite により 2GiB の `mediaUploadApi` へルーティングし、`mastodonApi` (256MiB)
  での sharp 処理による OOM を防ぐ (ADR-0093)。
- **古い画像ファイルの削除:** 新しい画像の保存成功時および DELETE API 実行時、
  更新前の画像 URL が当インスタンスの Storage バケット内であれば古いファイルを削除する。
  初期設定等の外部 URL は削除しない。
- **ActivityPub 配送:** actor の `icon` / `image` を更新または削除し、
  `apex.publishUpdate` で `Update(Person)` を outbox に積んで連合先に配送する。

## 理由

- 独立パス保存により投稿添付ライフサイクルとの干渉を防ぎ、不要になった古い画像を即時削除してストレージ浪費を抑えられる。
- 重い画像リサイズ処理を `mediaUploadApi` に集約することで、通常 API の安定稼働と低コストを維持できる。

## 参照

- 関連 Issue: #220
- 関連 ADR: [[ADR-0091]], [[ADR-0092]], [[ADR-0093]]
