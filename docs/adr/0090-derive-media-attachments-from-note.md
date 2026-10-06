# ADR-0090: Note の attachment から MediaAttachment を導出する

- **Status:** Accepted
- **Date:** 2026-10-07

## 背景

Mastodon API の Status に含まれる `media_attachments` はこれまで空配列のままだった (Issue #217)。
受信した Note や自身の Note の `attachment` から `MediaAttachment` エンティティを導出するにあたり、
ID 体系、メタデータ展開、ローカル/リモートの区別方針を決定する必要がある。

## 決定

- **導出関数は純粋関数とする:** `functions/src/mastodon/statusAttributes.ts` に `noteToMediaAttachments` を置き、
  Firestore I/O を行わずに同期的に計算する (→ [[ADR-0060]])。
- **ID は Status ID とインデックスから合成する:** `${statusId}${index}` (例: 20桁 Status ID + インデックス) とする。
  Mastodon ID (20桁) と桁数が異なるため衝突せず、数値文字列の要件を満たし、DB への追加採番トランザクションを不要にする。
- **拡張語彙のキー探索:** apex は受信オブジェクトを AS2/Security コンテキストで `compact` するため、
  Mastodon 拡張は `http://joinmastodon.org/ns#blurhash` / `#focalPoint` の完全 IRI として保存される。
  これらと短縮キー (`toot:blurhash`, `blurhash` 等) の双方を探索して値を抽出する。
- **メタデータ構造:** `width` / `height` が存在する場合は `meta.original` / `meta.small` にアスペクト比等を含めて構築する。
  `focalPoint` が存在する場合は `meta.focus: { x, y }` を設定する。
- **URL と種別:** `url` が配列や Link オブジェクト (`href`) の場合も正規化して拾う。
  画像は `preview_url` に同じ URL を入れ、リモート添付は `remote_url` にも同じ URL を設定する。
  ローカル投稿は `remote_url: null` とする。

## 理由

- 添付ごとの Firestore 採番を行うと Status 読み出し時やタイムライン取得時のオーバーヘッドが増加する。
  Status ID に紐づく決定論的な ID 生成により、高速かつ一貫した ID が得られる。
- 受信した Firestore 実データにおいて `http://joinmastodon.org/ns#` 形式で格納されていることが確認されており、
  実データとローカル生成データの双方に対応できる。

## 参照

- 関連 Issue: #217
- 関連 ADR: [[ADR-0006]], [[ADR-0058]], [[ADR-0060]]
