# ADR-0160: 自分のピン留め投稿を `featured` コレクションとして公開し、`Add` / `Remove` を配送する

- **Status:** Accepted
- **Date:** 2026-10-24

## 背景

Issue #319。リモートアカウントのピン留め受信 (#318, ADR-0144) は実装済みだが、自分のピン留めは外部に連合していない。
Elk 等からピン留めすると `userInfos/{actor}/pins` に保存されるが、ローカル actor に `featured` プロパティがなく、
コレクションも公開されておらず、ピン留め・解除時の `Add` / `Remove` も配送されないため、リモートからピン留めが見えない。

## 決定

1. **`featured` コレクションの URL と公開範囲**:
   URL は `/activitypub/u/:actor/collections/featured` とする。`OrderedCollection` として返し、ピン留めされた新しい順に Note オブジェクトを `orderedItems` に埋め込む。
   未認証・外部からのアクセス時は公開・非収載 (`apex.isPublic(note)`) の Note のみを含め、非公開 (followers-only) は除外する。認証済みの本人アクセス時のみ非公開も含める。
2. **コレクション組み立ての責務境界 (ADR-0042)**:
   `pins` 射影からの組み立てと HTTP ルートは**本体側** (`social/pins.ts`, `activitypub.ts`) に置く。Firestore の `userInfos/{actor}/pins` や `featured` 拡張の解釈は本体固有の責務である。
   apex フォークは `ApexRoutes` / `createActor` での `featured` 属性の許容、および `functions/src/apex.ts` の context への `toot:featured` 定義のみにとどめる。
3. **`Add` / `Remove` の宛先と配送 (ADR-0003)**:
   ピン留め・解除 API (`POST /api/v1/statuses/:id/pin`, `/unpin`) 成功時、`target` を自身の `featured`、`object` を Note の IRI とした `Add` / `Remove` を `actor.followers` 宛てに配送する。
   一時的アクティビティ (AP §3.1) として扱うため `outbox` (Streams) には保存せず、`apex.publishActivity` で直接 Cloud Tasks に投入する。Cloud Tasks のペイロード検証および配送記録 (`deliveries`) と整合させるため、一意な `id` を付与する。
4. **既存フォロワーへの通知**:
   デプロイ後に `/activitypub/publishProfileUpdate` を実行し、`featured` を含む `Update(Person)` を配送する。未設定のローカル actor はこの実行時または作成時に `featured` を付与して保存する。

## 理由

- Mastodon / Misskey は actor の `featured` コレクションおよび `Add` / `Remove` を通じてピン留めを同期する。
- 一時的アクティビティとして配送することで、不要な `Streams` 肥大化や outbox 汚染を防ぎつつ既存の Cloud Tasks 配送基盤を活用できる。

## 結果

- リモートの Mastodon / Misskey から自分のプロフィールを見たときにピン留めが表示され、ピン留め・解除がフォロワーに反映される。

## 参照

- 関連 Issue: [#319](https://github.com/hakatashi/activitypub-firebase/issues/319)
- 関連 ADR: [[0003-delivery-via-cloud-tasks]], [[0042-apex-fork-responsibility-boundary]], [[0144-receive-remote-pinned-statuses]]
