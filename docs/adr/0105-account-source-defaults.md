# ADR-0105: 既定の公開範囲などの投稿設定は `userInfos/{actor}.source` に保存する

- **Status:** Accepted
- **Date:** 2026-10-09

## 背景

Issue #230。`update_credentials` は `source[privacy]` / `source[sensitive]` / `source[language]` を受け取って
捨てており、CredentialAccount の `source` と `GET /api/v1/preferences` は固定値、投稿の `visibility`
省略時は常に `public` だった。Elk / Phanpy で既定の公開範囲を変えても再読み込みで戻る。

## 決定

1. **`UserInfo` に省略可能な `source: { privacy, sensitive, language }` を持たせる** ([ADR-0023](0023-firestore-schema-as-types.md))。
   既存ドキュメントにはないので、読み取り側 (`resolveAccountSource`) で既定値を補う。
   未設定の値は `null` として保存し、`update_credentials` は送られた項目だけを上書きする。
2. 既定値は Mastodon (`User::HasSettings`) に合わせる。
   - `privacy` 未設定なら、鍵アカウントは `private`、そうでなければ `public`。
   - `sensitive` 未設定なら `false`。
   - `language` 未設定 (空文字で送られた場合を含む) なら `ja`。Mastodon は CredentialAccount の
     `source.language` に `null` を返すが、Elk はそのときブラウザの言語 (`en` など) を使うため、
     利用者の言語である `ja` を返す。
3. **`source[privacy]` に `direct` は受け付けず 422 を返す** (Mastodon の `default_privacy` の許容値と同じ)。
4. `POST /api/v1/statuses` は Mastodon の `PostStatusService` と同じく、`visibility` / `language` が
   省略されたら保存値を使い、`sensitive` が省略されたら保存値を使う (注意書きがあれば常に `true`)。
5. `source` は Account (`actorObjectToAccount`) には含めない。CredentialAccount と preferences だけに出す。

## 理由

- 設定は利用者本人にしか関係しない値なので、actor ではなく `userInfos` に置く。
- 既定値を読み取り側で補えば、既存ドキュメントの移行が要らない。

## 参照

- [[0023-firestore-schema-as-types]]、[[0094-avatar-header-update-and-credentials]]
- 関連 Issue: [#230](https://github.com/hakatashi/activitypub-firebase/issues/230)
