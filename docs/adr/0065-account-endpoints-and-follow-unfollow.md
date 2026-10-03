# ADR-0065: アカウント系エンドポイントとフォロー・アンフォローの ActivityPub 連携

- **Status:** Accepted
- **Date:** 2026-10-03

## 背景

Mastodon API のアカウント系エンドポイントが不足しており、Elk などのクライアントでプロフィール表示、
フォロー関係の確認・操作、設定変更ができない (Issue #62)。
特に `verify_credentials` が `role` を返さないため Elk の初期化が例外でクラッシュしていた。

## 決定

1. **`GET /api/v1/accounts/verify_credentials`**
   - `actorObjectToAccount` で完全な Account を組み立て、`source` (プライバシー設定・プレーンテキスト bio・fields 等) を付与。
   - `role` に `{ id: '-99', name: '', permissions: '0', color: '', highlighted: false }` を返してクライアントのクラッシュを防ぐ。
2. **`GET /api/v1/accounts/:id` と `lookup`**
   - `:id` は UserInfo から対応する actor を引いて Account を返す (無ければ 404)。
   - `lookup` は他ドメインや存在しない acct に対し 500 を投げず 404 を返す。
3. **`GET /api/v1/accounts/:id/following`**
   - 送信した Follow のうち Accept 済みかつ Undo されていないものを取得。
   - Follow の Mastodon ID をカーソルとし、`getFollowersPage` と同様に `Link` ヘッダでページネーションする ([[ADR-0062]])。
4. **`GET /api/v1/accounts/relationships`**
   - クエリ `id[]` の各アカウントに対し、認証ユーザーとのフォロー・被フォロー・申請中 (未 Accept) の実データを元に Relationship を返す。
5. **`PATCH /api/v1/accounts/update_credentials`**
   - 表示名・bio・locked・discoverable・fields を `UserInfo` と `actor` に反映して保存。
   - 保存後に `apex.publishUpdate(actorWithMeta, actor)` でフォロワーに Update を配送する。
6. **`POST /api/v1/accounts/:id/follow` と `/unfollow`**
   - follow: `Follow` アクティビティを構築して `apex.addToOutbox` で相手に配送。
   - unfollow: 対象の `Follow` を `following`/`outbox` から取得し、`Undo(Follow)` を配送した上で `apex.store.removeActivity` で削除。
   - いずれも最新の `Relationship` を返す。

## 理由

- Elk 等の Mastodon クライアントとの互換性を確保しつつ、ActivityPub の標準的なフォロー・更新フローと整合させる。

## 結果

- Elk でログイン・プロフィール閲覧・編集・フォロー・アンフォローが動作する。

## 参照

- 関連 ADR: [[ADR-0019]]、[[ADR-0021]]、[[ADR-0060]]、[[ADR-0062]]
- 関連コード: `functions/src/mastodon/api.ts`、`functions/src/store.ts`
