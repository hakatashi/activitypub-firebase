# ADR-0009: actor の秘密鍵を Phase 0 のうちにローテーションする

- **Status:** Accepted
- **Date:** 2026-09-04

## 背景

`functions/src/store.ts` の `deliveryEnqueue` が actor の秘密鍵(`_meta.privateKey`)を
`logger.info` で平文出力しており、Cloud Logging に既存ログとして残っている可能性がある
(#11)。ログ出力自体は修正するが、**既に流出した鍵は無効化しない限り危険なまま**である。

鍵をローテーションすると、リモートサーバーがキャッシュしている公開鍵と一致しなくなり、
その間は HTTP Signature の検証が失敗しうる。通常はこれは避けたい副作用だが、
現時点では [ADR-0003](0003-delivery-via-cloud-tasks.md) 未実装のため
**配送ワーカーが存在せず、この秘密鍵で署名した送信リクエストは1件も存在しない**
(`docs/known-issues.md` 最重要項目)。つまり今この鍵をローテーションしても、
署名検証の失敗は理論上発生しない。Phase 1 で配送を実装した後にローテーションすると、
実際に配送中のリクエストや、フォロワーがキャッシュした公開鍵との不整合が発生しうる。

## 決定

**Phase 0 のうち、配送機能が実装される前に actor の鍵をローテーションする。**

1. `functions/bin/rotateActorKey.ts` に一度きりの管理スクリプトを追加する。
2. apex の `createActor` と同じパラメータ(RSA / `modulusLength: 4096` /
   `spki` + `pkcs8` PEM)で新しい鍵ペアを生成する。
3. `Store#updateObject` 経由で actor オブジェクトの `publicKey.publicKeyPem` と
   `_meta.privateKey` を更新する。`updateObjectCopies` が既存の
   `deliveryQueue`(廃止予定)内のコピーも追従させる。
4. 鍵material そのものはログに出力しない(#11 の方針を流用)。
5. 実行対象は dev プロジェクトで先に検証し、問題なければ本番プロジェクトに対して実行する。

## 理由

- 配送が未実装の現在は「切り替えた瞬間に誰かの検証が失敗する」リスクが実質ゼロ。
  Phase 1 着手後に持ち越すほどリスクが上がる一方なので、待つ理由がない。
- スクリプトは apex 本体のロジックを呼ばず Firestore を直接更新する。
  apex の `createActor` は新規 actor 作成用であり、`id` や `following` /
  `followers` などの既存フィールドを壊さずに鍵だけ差し替える経路がないため。

検討したが採らなかった案:

- **ローテーションを見送り、ログ削除だけで済ませる。** 既存ログに残った鍵が
  無効化されないまま残るため、#11 の「鍵ローテーションを検討する」を満たさない。
- **Phase 1(配送実装)の後にまとめて行う。** 配送が動き出すと実際の署名検証との
  衝突リスクが生まれる。今より安全になる理由がない。

## 結果

- actor の `publicKey.publicKeyPem` が変わるため、鍵ローテーション後は
  WebFinger/actor エンドポイントが新しい公開鍵を返す。
- 既存ログに残っている旧鍵は無効化される(鍵自体のローテーションであり、
  ログの削除や過去ログの改変は別途 Cloud Logging 側の保持設定に委ねる)。
- `functions/bin/rotateActorKey.ts` は使い捨てスクリプトであり、恒久的な
  運用コマンドとして npm scripts には登録しない。

## 参照

- [[ADR-0003]] 配送は Cloud Tasks で行う
- 関連コード: `functions/src/store.ts` (`updateObject` / `updateObjectCopies`)
- 関連コード: `functions/node_modules/activitypub-express/pub/actor.js` (`createActor` の鍵生成パラメータ)
- Issue #11
