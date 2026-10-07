# ADR-0091: メディアのアップロードと Cloud Storage 保存

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Mastodon クライアントからのメディア添付を可能にするため、メディアアップロード API (`POST /api/v2/media` 等)
の実装と Cloud Storage への保存が必要である (Issue #218)。
保存先・配信 URL の選定、受入れ形式とサイズ制限、セキュリティ上の EXIF 除去、メタデータ永続化方針を決定する。

## 決定

- **保存先と配信 URL:** Firebase 既定バケット (`${projectId}.firebasestorage.app`) に保存し、
  オブジェクト単位で公開読み取り (`makePublic()`) に設定して `https://storage.googleapis.com/${bucket}/${path}` を返す。
  Functions や Hosting rewrite を介さないため実行回数や同時実行枠を消費せず、GCS 転送費のみで運用コストを極小化できる。
- **受け付け形式と上限:** 画像のみ (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) を受け入れ、動画・音声は将来対応とする。
  サイズ上限は 10MB (`image_size_limit: 10485760`)、ピクセル上限は 16MP (`image_matrix_limit: 16777216`)。
  Content-Type ヘッダに依存せずマジックナンバーおよび sharp によるパースで検証し、不正な形式は 422 とする。
- **画像の加工とメタデータ:** `sharp` と `blurhash` を依存に追加する。
  EXIF (特に GPS) メタデータはプライバシー保護のため完全に除去する (`.rotate()` で向きを反映しメタデータを剥がす)。
  サムネイル (`preview_url`) は最大 512px で生成する。`blurhash` と幅/高さ/アスペクト比を算出する。
- **メタデータの保存先:** Firestore `mediaAttachments/{id}` コレクションに保存する。
  `id` は ADR-0006 の Mastodon ID 採番 (`generateMastodonId()`) を使用する。
- **Storage アクセス制御:** `storage.rules` でクライアント直接の読み書きを全面禁止 (`allow read, write: if false;`) する。
  書き込みは Cloud Functions 経由のみとし、読み取りは公開オブジェクト URL 経由とする。

## 理由

- オブジェクト直接配信により Functions のコールドスタートや同時実行制限の影響を受けず、個人インスタンスの無料枠内で費用を抑えられる。
- 位置情報等の EXIF を確実に除去することで、連合先や外部閲覧者への情報漏洩を防ぐ。
- バケットへの直接アクセスを遮断することで、認証外の書き込みや不正なオブジェクト改変を防止できる。

## 参照

- 関連 Issue: #218
- 関連 ADR: [[ADR-0006]], [[ADR-0081]], [[ADR-0090]]
