# ADR-0127: インポートした投稿の添付メディアを Cloud Storage に取り込む

- **Status:** Accepted
- **Date:** 2026-10-13
- **Supersedes:** [[ADR-0126]] の添付メディア未転送方針

## 背景

Issue #269。[[ADR-0126]] で取り込んだ過去投稿の添付メディアを、Mastodon アーカイブの `media_attachments/` から Cloud Storage に取り込み、Status の `media_attachments` として表示可能にする必要がある。

## 決定

1. **保存先のパスと ID 抽出:** アーカイブ内の相対パス (`media_attachments/files/<分割ID>/original/<ファイル名>`) をそのまま Cloud Storage の保存パスとし、公開 URL を `Note.attachment[].url` に設定する。画像のサムネイルは `/original/` を `/small/` に置換したパスに保存し、`icon: { type: 'Image', url: previewUrl }` に設定する。新規アップロード (`media_attachments/files/<20桁ID>/original.<ext>`) と階層が異なるため衝突しない。`statusAttributes.ts` のローカル ID 抽出正規表現は `/\/media_attachments\/files\/(?<id>[0-9]+)\/original\./` に限定し、分割パスの先頭セグメント誤一致を防ぐ (インポート分は [[ADR-0090]] の `${statusId}${index}` で採番)。
2. **`mediaAttachments` コレクションと `cleanupMediaTask`:** `mediaAttachments` コレクションには登録しない。Status の `media_attachments` は Note の `attachment` から直接導出され ([[ADR-0090]])、`cleanupMediaTask` ([[ADR-0092]]) は `MediaAttachments.where('statusIri', '==', null)` のみを走査するため、インポートしたファイルが削除されることはない。
3. **画像・GIF・動画の扱いとメタデータ:** オリジナルは再圧縮劣化を避けるためアーカイブ内のバイナリをそのままアップロードする (移行元で EXIF 除去および動画の H.264 MP4 トランスコード済み)。画像 (`image/*`) は `sharp` で長辺最大 512px の静止画サムネイル (GIF は1フレーム目) を生成して `small` に保存する。動画 (`video/mp4`)・音声はオリジナルのみ保存し `preview_url: null` とする。`name` (代替テキスト)・`blurhash`・`focalPoint`・`width` / `height` を引き継ぎ、古い投稿で `blurhash` や寸法が欠落している画像は `sharp` と `blurhash` で算出して補完する。
4. **冪等性と再開性:** `importArchive.ts` に統合する。アップロード前に Cloud Storage の `file.exists()` を確認して二重アップロードを防ぐ。Firestore 上に Note が既に存在する場合でも、`attachment[].url` が相対パスのままならメディアを取り込んで `updateObject` / `updateActivity` で更新し、途中停止状態から再開可能にする。`--dry-run` でメディア件数・種別内訳・総容量を表示する。

## 理由

- アーカイブ内の相対パスをそのまま使うことで決定論的にパスが一意に定まり、`file.exists()` による冪等な再実行が容易になる。
- 画像サムネイルの生成と欠落 `blurhash`・寸法の補完により、タイムラインの転送量を抑えつつ 2017〜2019 年の古い投稿も一貫して表示できる。

## 参照

- 関連 ADR: [[ADR-0090]], [[ADR-0091]], [[ADR-0092]], [[ADR-0126]]
- 関連 Issue: #269
