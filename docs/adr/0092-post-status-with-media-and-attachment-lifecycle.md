# ADR-0092: media_ids によるメディア添付投稿とライフサイクル

- **Status:** Accepted
- **Date:** 2026-10-07
- **Supersedes:** [[ADR-0063]] の media_ids 未対応方針

## 背景

Phase 4 において画像付き投稿を実現するため、`POST /api/v1/statuses` の `media_ids` 対応と Note の `attachment` 構築、
Status の `media_attachments` への反映、未添付メディアの後始末が必要である (Issue #219)。

## 決定

- **投稿時の media_ids 検証:**
  - 最大4件 (`max_media_attachments`) まで受け付け、超過は 422 とする。
  - すべて自 actor のアップロードかつ `statusIri === null` (未添付) であることを検証し、違反は 422 とする。
  - メディア添付時は本文 (`status`) が空でも許可する (テキストのみで空の場合は 422)。
- **Note への attachment 付与と JSON-LD context:**
  - `publishNote` に `attachments` を渡し、Note の `attachment` に `Document` オブジェクトとして格納する。
  - 外部配送時の JSON-LD コンテキストに `toot` 拡張 (`blurhash`, `focalPoint`) を追加し、属性脱落を防ぐ。
- **Status 出力時の ID 一致:**
  - Status の `media_attachments` では、ローカルのメディア添付についてはアップロード時の `mediaAttachments` ID を引き継ぐ。
- **メディアの紐付けと後始末:**
  - Note 保存成功時に添付されたメディアの `statusIri` を Note IRI で更新する。
  - 添付されないまま24時間以上経過したメディアは、日次スケジュール (`onSchedule`) で Storage ファイルと Firestore メタデータの双方を削除する。
  - 投稿削除時は「削除して再編集」を可能とする Mastodon 仕様に合わせ、メディアファイルは即時削除しない。

## 理由

- クライアント (Elk 等) は投稿前後でメディア ID の一致を前提としてプレビューを突き合わせる。
- アップロード後に投稿されなかった孤立ファイルを自動破棄することで、ストレージの不要な肥大化を防ぐ。

## 参照

- 関連 Issue: #219
- 関連 ADR: [[ADR-0063]], [[ADR-0090]], [[ADR-0091]]
