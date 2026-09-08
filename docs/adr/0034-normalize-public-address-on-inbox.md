# ADR-0034: inbox で受信したアクティビティの as:Public 宛先表現を正規化する

- **Status:** Superseded by ADR-0045
- **Date:** 2026-09-08

## 背景

ActivityPub の公開宛先は JSON-LD compact の結果によって `"as:Public"`,
`"https://www.w3.org/ns/activitystreams#Public"`, `"Public"` の3通りで届きうる。
apex の内部定義 (`pub/consts.js`) では `publicAddress: 'as:Public'` のみを期待しており、
素の `"Public"` のまま保存されると `apex.isPublic()` が false を返し、
公開コレクションのフィルタで匿名リクエストからアクティビティが見えなくなる (Issue #54)。

## 決定

**`apex.net.inbox.post` の検証ミドルウェア通過後・保存直前に薄いミドルウェア `normalizeInboxPublic` を挿入し、
受信アクティビティ (`req.body`) および解決済みオブジェクト (`res.locals.apex.object`) の
audience フィールド (`to`, `cc`, `bto`, `bcc`, `audience`) に含まれる `"Public"` および
`"https://www.w3.org/ns/activitystreams#Public"` を `"as:Public"` に正規化する。**
[ADR-0030](0030-inbox-redundant-delivery-detection.md) / [ADR-0031](0031-update-delete-same-origin-check.md) /
[ADR-0033](0033-denormalize-undo-object.md) と同様、apex 本体は変更せずミドルウェアで対応する。

## 理由

- 外部サーバーがどのような表記揺れ (フル URI / term 名 / コンパクト表記) で送信してきても、
  Firestore に保存されるアクティビティ・オブジェクトの公開宛先が `"as:Public"` に統一される。
- `apex.isPublic()` が確実に true を返し、公開タイムラインやコレクションで正常に表示される。
- 宛先解決 (`apex.address`) においても `publicAddress` として確実に除外され、
  `"Public"` に対する不正なリモートフェッチを防止できる。

## 結果

- 新規ファイル `functions/src/inboxPublic.ts` にミドルウェアを実装する。
- `functions/src/activitypub.ts` の inbox パイプラインに `normalizeInboxPublic` を追加する。
- 3通りの表現いずれを受信しても `apex.isPublic()` が true になることをテストで固定する。

## 参照

- [[ADR-0002]] activitypub-express を継続利用し、配送層のみ差し替える
- [[ADR-0030]] inbox の重複配送検出を、apex 本体を変更せず前後の薄いミドルウェアで行う
- [[ADR-0033]] inbox で受信した Undo の object を保存前に解決済みオブジェクトで埋め込む
- 関連 Issue: [#54](https://github.com/hakatashi/activitypub-firebase/issues/54)
