# ADR-0162: ボットの投稿で外部 URL 直リンク画像を添付できるようにする

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

ボットの運用(気象レーダー画像、Webカメラ、フィード転載など)では、すでに Web 上にある画像 URL を
そのまま添付したい場面が多い(#398)。現行のフローでは事前に `POST /api/v2/media` でダウンロード・再アップロード
が必要で、Cloud Storage 容量の圧迫、Cloud Functions 実行時間や帯域の消費、ボット側の多段リクエストの
負担が生じていた。ActivityStreams 2.0 およびリモートの Mastodon / Misskey では、Note の `attachment` の
`url` に外部 URL を指定可能で、リモート側が非同期にフェッチ・キャッシュして表示できる。

## 決定

1. **API インターフェース:**
   `POST /api/v1/statuses` のパラメータに `media_urls` を追加する。
   各要素はオブジェクト `{ url, description?, mime_type?, width?, height?, blurhash? }`
   または単一の URL 文字列とする。
2. **ボットアカウント限定:**
   `media_urls` の利用は `userInfo.bot === true` のボットアカウントのみに制限する。
   ボット以外のアカウントが `media_urls` を指定した場合は 403 Forbidden とする。
3. **添付数の検証:**
   `media_ids` と `media_urls` の合計件数が `max_media_attachments` (4 件) を超えないことを検証する。
4. **サーバー側での外部画像フェッチを行わない:**
   Cloud Functions 側で外部画像ファイルのダウンロードや sharp による解析は一切行わない。
   指定された画像形式 (`mime_type`)、画像サイズ (`width`/`height`)、blurhash は内製ボットからの値を信頼して採用する。
5. **URL の検証:**
   スキームは `https:` を必須とし、不正なスキームおよびローカルホストやプライベート IP
   (`localhost`, `127.0.0.1`, `169.254.169.254` 等) へのリンクは 422 で拒否する。
6. **Note の構築と配信:**
   `publishNote` の `NoteAttachment` に外部 URL および指定されたメタデータを設定し、
   Cloud Storage へのアップロードや `MediaAttachments` コレクションへの書き込みは行わない。

## 結果

- ボットが 1 回の API 呼び出しで外部 URL 画像を添付投稿できるようになり、ストレージや関数のコストを削減できる。
- 外部画像を自サーバーがフェッチしないため、SSRF やタイムアウトのリスクを排除できる。

## 参照

- Issue: [#398](https://github.com/hakatashi/activitypub-firebase/issues/398)
- 関連 ADR: [ADR-0063](0063-post-status-and-idempotency-key.md)、[ADR-0090](0090-media-attachments-in-statuses.md)、[ADR-0149](0149-bot-actors-as-additional-local-actors.md)、[ADR-0151](0151-bot-operator-token.md)
