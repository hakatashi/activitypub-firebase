# ADR-0032: リモートオブジェクト取得 (`requestObject`) を自前の SSRF セーフな実装に差し替える

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

apex の `resolveObject` / `resolveUnknown` は未知の IRI を `requestObject` でそのまま
fetch する。`net/activity.js` の `resolveThread` → `apex.resolveReferences(req.body)` が
inbox 経由で `inReplyTo` / `object` / `target` / `tag` を再帰的に解決するため、**リモートが
指定した任意の URL へサーバーが到達する**(→ [Issue #52](https://github.com/hakatashi/activitypub-firebase/issues/52))。

apex 本体の `isLocalhostIRI`(`pub/utils.js`)は `https://localhost` /
`http://127.0.0.1` の前方一致のみで、本番環境限定・プライベート IP レンジ/リンクローカル
(`169.254.0.0/16` を含む GCP メタデータサーバー)/IPv6 は一切カバーしない。DNS 解決結果の
検証もない。[ADR-0002](0002-keep-activitypub-express.md) により apex 本体は変更しない。

## 決定

**apex 本体は変更せず、`apex.ts` で `apex.requestObject` をインスタンス生成後に
自前実装で上書きする。** `index.js` が `pub/*` の全関数を `apex[prop] =
pub[prop].bind(apex)` として直接代入しているため、この差し替えだけで
`resolveObject` / `resolveUnknown` / `resolveReferences` / `activity.js` 内の呼び出しすべてに
反映される。

新実装 (`functions/src/security/`) は Node 標準の `fetch` と `node:crypto` のみで構成し、
`request` / `request-promise-native` / `http-signature`([ADR-0002](0002-keep-activitypub-express.md)
で受容済みの deprecated / 個人 fork 依存)を新たに直接依存へ加えない。HTTP Signature は
GET 用(`(request-target)` / `host` / `date` のみ、digest 不要)を `node:crypto` の
`sign('sha256', data, pemPrivateKey)` で自前計算する(`third_party/minipub/src/crypto.ts`
を参考にしつつ、Node は PEM を直接扱えるため WebCrypto 変換は不要)。

URL 検証: スキームは `https:` 限定。ホスト名は DNS 解決し、得られた全アドレスを `ipaddr.js` の
`range()` に通し `'unicast'` 以外(loopback/private/linkLocal/uniqueLocal/carrierGradeNat/
reserved 等)を拒否する。dev projectId (`activitypub-firebase-dev`) にデプロイされた本物の
Cloud Functions は本番同様クラウド上で動くため特別扱いしない。判定は `projectId` ではなく
`FUNCTIONS_EMULATOR === 'true' || NODE_ENV === 'test'`(`activitypub.ts` の `adminOnly` と同じ
基準)にし、この場合のみ `http:` と loopback アドレスを追加で許可する(エミュレータ/テストが
実際に localhost のモックサーバーへ到達する必要があるため)。
3xx はリダイレクト先 URL に同じ検証を再度通してから追跡する(最大5ホップ)。レスポンスは
`content-length` の事前チェックとストリーム読み取り中のカウントで上限(5MB)を強制し、
`apex.requestTimeout` を `AbortSignal.timeout` で適用する。拒否は理由と URL を `logger.warn` に残す。

`resolveReferences` の再帰深さは既存の `apex.threadDepth`(既定10)で既に上限があるため
追加対応は不要と判断する。

## 理由

- HTTP Signature は連合の根幹で壊れると静かに死ぬ([ADR-0002](0002-keep-activitypub-express.md))が、
  GET 用は digest 計算が不要な分 `deliver`(POST)より移植リスクが低い。`deliver` 側は
  このADRのスコープ外とし、既存の `request-promise-native` 実装を維持する。
- `request` 系パッケージを新たに直接依存へ加えると ADR-0002 が受容したリスクをさらに
  拡大する。fetch + `node:crypto` の標準機能だけで完結させれば依存を増やさずに済む。

## 結果

- 新規: `functions/src/security/ssrf.ts` / `httpSignature.ts` / `safeRequestObject.ts`
- `functions/src/apex.ts` で `apex.requestObject` を差し替え
- `functions/package.json` に `ipaddr.js` を直接依存として追加(既に間接依存として導入済み)

## 参照

- [[ADR-0002]] activitypub-express を継続利用し、配送層のみ差し替える
- 関連 Issue: [#52](https://github.com/hakatashi/activitypub-firebase/issues/52), [#7](https://github.com/hakatashi/activitypub-firebase/issues/7)
- `functions/node_modules/activitypub-express/{index.js, pub/federation.js, pub/object.js, pub/utils.js}`
- `third_party/minipub/src/crypto.ts`(自前 HTTP 署名の参考実装)
