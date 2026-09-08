# ADR-0036: draft-cavage 以外の署名形式を事前に 403 で弾く

- **Status:** Superseded by ADR-0044
- **Date:** 2026-09-08

## 背景

Issue #55 の実地検証で、`mastodon-test.hakatashi.com` からの `Like` / `Announce` の inbox 配送が
毎回 500 を返し、Sidekiq が最大16回まで再送を繰り返し続ける不具合を発見した。

原因を Cloud Functions のログ(一時的に `Signature` ヘッダーの生値を記録して確認、確認後削除済み)
から特定した:

- 同じアクティビティに対し、mastodon-test は **draft-cavage 形式の `Signature` ヘッダー**
  (`keyId="...",algorithm="...",headers="...",signature="..."`)と、
  **RFC 9421 (HTTP Message Signatures) の構造化フィールド形式**
  (`sig1=:<base64>:`)の**両方**で配送を試みている
  (署名アルゴリズム移行期のフェディバースでの二重配信と見られる)。
- apex (`activitypub-express`) の署名検証は `node_modules/http-signature`
  (draft-cavage 専用のフォーク、[ADR-0002](0002-keep-activitypub-express.md) により固定)を使う。
  RFC 9421 形式の値を渡すと `parseRequest` が `InvalidHeaderError: bad param format` を投げる。
- apex 本体 (`net/security.js` の `verifySignature`) はこの例外を丸ごと catch し、
  区別なく `res.status(500).send()` を返す。
- 500 は「一時的なサーバー障害」として解釈されるため、Mastodon は
  同じアクティビティを繰り返し再送し続ける(初回の draft-cavage 版は 200 で成功しているにも
  かかわらず、RFC 9421 版の再送が永遠に失敗し続ける)。

## 決定

**`Signature` / `Authorization` ヘッダーが draft-cavage 形式のパラメータ
(`name="value"` の並び)を含まない場合、apex 本体の `verifySignature` を呼ぶ前に
403 を返して打ち切る。**

- `functions/src/inboxSignature.ts` に判定用の薄いミドルウェアを実装する。
- `functions/src/activitypub.ts` の inbox POST パイプラインの先頭
  (`inboxValidationMiddlewares` より前)に挿入する。
- 判定は正規表現 `/(^|,)\s*[A-Za-z]+="/` で「`name="` の並びが最低1つ含まれるか」だけを見る、
  最小限のフォーマットチェックとする。`http-signature` パッケージ自体を import して
  実際にパースを試みる方法も検討したが、apex が使うのは npm 公式パッケージではなく
  フォーク(`wmurphyrd/node-http-signature`、apex の `package.json` 参照)であり、
  自前で依存に追加すると解決されるパッケージが一致する保証がなく、
  ADR-0002 の「apex 本体には手を入れない」という原則に対しても余分な依存を増やすことになる。
  実際に発生した具体的な失敗モード(RFC 9421 の構造化フィールド形式)を弾ければ十分なため、
  文字列パターンでの判定にとどめる。

## 理由

- 403 は apex 自身が「署名を検証したが不正だった」場合に返す実際のステータスと同じであり、
  意味的に正しい(401 は apex の慣習では「署名ヘッダーが全く無い」場合専用)。
- Mastodon 側の `response_error_unsalvageable?`
  (`app/helpers/json_ld_helper.rb`, third_party/mastodon)は
  `response.code == 501 || ((400...500).cover?(response.code) && ![401, 408, 429].include?(response.code))`
  という判定で「再送しても無駄」と早期に諦めるかどうかを決めている。401 はこの除外対象
  (「鍵のローテーション直後かもしれないので再送する価値がある」という想定)に含まれるため、
  401 のままでは Mastodon は結局 16 回まで再送し続けてしまい、500 のときと実質的に
  変わらない。403 であれば `@unsalvageable = true` となり、無駄な再送が即座に止まる。
- 事前チェックのみで apex 本体のロジック自体は変更しないため、
  draft-cavage の実際の暗号学的検証(鍵の解決・署名の妥当性確認)は引き続き apex に委譲される。
- RFC 9421 自体への対応(構造化フィールドのパースと検証)は別のスコープが大きい機能追加であり、
  このバグ修正には含めない。

## 結果

- `functions/src/inboxSignature.ts` を新設する。
- draft-cavage 形式でない `Signature` ヘッダーに対して 403 が返り、
  apex 本体の `verifySignature` が呼ばれない(500 にならない)ことをテストで固定する。
- RFC 9421 自体のサポートは別 Issue として起票する。

## 参照

- [[0002-keep-activitypub-express]]
- 関連 Issue: [#55](https://github.com/hakatashi/activitypub-firebase/issues/55)
