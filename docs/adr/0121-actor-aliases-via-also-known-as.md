# ADR-0121: alsoKnownAs によるアカウント別名管理と配信

- **Status:** Accepted
- **Date:** 2026-10-12

## 背景

Mastodon や Misskey からのアカウント移行では、移行先 actor の `alsoKnownAs` に旧アカウントの actor URI が含まれていることが必須である。
しかし apex は JSON-LD 出力時に `@context` に未定義の語をドロップするため、Firestore に保存するだけでは出力されない。
また別名設定用の Mastodon REST API は存在せず、安全かつ確実に設定・検証できる仕組みが必要である。

## 決定

1. `functions/src/apex.ts` の `context` に `alsoKnownAs` (`as:alsoKnownAs`) と `movedTo` (`as:movedTo`, 受信用) を追加する。
2. 別名はローカル actor オブジェクトの `alsoKnownAs` プロパティ（URI 文字列配列）として管理する。
3. 管理者エンドポイント（`/activitypub/aliases`、`X-Hakatashi-Token` 認証）で GET（一覧）、POST（追加）、DELETE（削除）を提供する。
4. 入力は `acct` (`user@host`) または actor URI を受け付け、WebFinger および actor 取得により同一オリジン・アクター型を検証する。自分自身は拒否する。
5. 別名の追加・削除時は Firestore を更新し、`apex.publishUpdate` でフォロワーに `Update(Person)` を配送する。
6. `update_credentials` やアバター変更等の既存 actor 保存処理で `alsoKnownAs` を維持する。

## 理由

- 定数による管理は環境差分やリハーサル・本番移行時のデプロイ頻度が高まりリスクが大きい。
- 管理者エンドポイントで検証と配送を完結させることで、誤った URI 設定を即座に検知し、安全に `Update(Person)` を届けられる。
- 転出は行わないため、自サーバーからの `movedTo` 出力は行わない。

## 結果

- ローカル actor の JSON-LD 出力に `alsoKnownAs` が含まれ、`@context` に語彙定義が付与される。
- 別名の設定・解除が安全に行え、旧インスタンスからの移行前検証を通過できる。

## 参照

- Issue: #265
- 関連 ADR: [[ADR-0042]], [[ADR-0094]], [[ADR-0097]]
- 関連コード: `functions/src/apex.ts`, `functions/src/activitypub.ts`, `functions/src/social/aliases.ts`
