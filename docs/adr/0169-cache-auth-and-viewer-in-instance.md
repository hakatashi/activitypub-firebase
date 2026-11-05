# ADR-0169: 認証の結果と閲覧者の actor をインスタンス内に 5 分キャッシュする

- **Status:** Accepted
- **Date:** 2026-10-31

## 背景

Issue #358。キャッシュが効いたタイムラインのポーリングでも、アクセストークン(`accessTokens` のクエリ)・
uid から UserInfo と actor の IRI(`userInfos` のクエリ)・閲覧者の actor(`objects`)の 3 回を毎回読んでいる。
認証の 2 回は `authRequired` を通るすべての API で起きる。トークンは無期限で、失効は revoke でしか起きない(ADR-0133)。

## 決定

1. **対象と TTL:** 次の 3 つをインスタンスのメモリに置き、覚えてから **5 分**で読み直す。参照しても延ばさない。
   - アクセストークン → uid・スコープ・有効期限・クライアント ID(`Oauth2Model.getAccessToken`)。
     キーはトークンの SHA-256 で、トークンそのものは値にも持たない。見つからなかったトークンは覚えない。
   - uid → UserInfo と actor の IRI(`resolveAuth`)。ボットのオペレータートークン(ADR-0151)の分は対象外。
   - actor の IRI → 閲覧者の actor(`_meta` 込み。`loadViewer` / `getLocalActor`)。
2. **上限:** それぞれ 64 件の LRU。ユーザーは 1 人で、トークンはクライアントごとに数件しかない。
3. **無効化(同じインスタンスのみ):**
   - `revokeToken` は、消したアクセストークンのキャッシュを消す。
   - `touchesTimelineView`(ADR-0139 決定3)は、その actor の UserInfo と actor のキャッシュを消す。
4. **返す値は毎回複製する。** 呼び出し側が actor を書き換えてもキャッシュを汚さない。
5. **actor を保存するルートはキャッシュを使わない。** `update_credentials` とプロフィール画像の削除は
   Firestore から読み直す。古い actor を書き戻して、他の変更を巻き戻さないため。
6. **`verify_credentials` は UserInfo を読み直す。** フォロワー数・投稿数は射影や投稿で変わり、
   キャッシュのままだとログイン直後の表示が 5 分遅れるため。呼ばれる頻度は低い。

## 理由

- 5 分なら、ポーリング(15〜20 秒ごと)の読み取りはほぼ 1/15 になる。一方で、他のインスタンスでの revoke や
  コンソールでのトークン削除が効くまでの遅れは、利用者 1 人の運用で許せる範囲に収まる。
- `update_credentials` は Hosting の rewrite で `mediaUploadApi` に回るので、`mastodonApi` のキャッシュを消せない。
  バージョンを読んで検証すると読み取りが残るので、5 分の遅れを許す。

## 結果

- 別のインスタンスでの revoke・コンソールでのトークン削除は、最大 5 分効かない。
- `update_credentials` の後、`mastodonApi` の既定の公開範囲(投稿・`/api/v1/preferences`)と閲覧者の actor は
  最大 5 分古い。
- テストではエミュレータを消すたびにキャッシュも消す(`resetFirestore`)。

## 参照

- 関連 Issue: [#358](https://github.com/hakatashi/activitypub-firebase/issues/358) / 関連 ADR: [ADR-0133](0133-non-expiring-access-tokens.md), [ADR-0139](0139-cache-timeline-head-page-in-instance.md), [ADR-0151](0151-bot-operator-token.md)
