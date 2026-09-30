# ADR-0056: HTTP 署名検証における Digest 検証と Date 有効期限チェックの追加

- **Status:** Accepted
- **Date:** 2026-10-01

## 背景

apex フォークの `verifySignature` ([ADR-0044](0044-self-implemented-http-signature-in-apex-fork.md)) は
暗号検証と鍵解決を行うが、改ざん検知 (`Digest`) とリプレイ攻撃防御 (`Date` 有効期限) が欠如していた。
POST リクエストで `digest` が署名対象に含まれず `req.rawBody` との照合もないため、署名流用による
ボディ改ざんのリスクがあり、`Date` 差分も未検査のため過去の署名付きリクエストを再送可能だった。

## 決定

[ADR-0042](0042-apex-fork-responsibility-boundary.md) に従い、apex フォーク (`security.ts`) 内で以下を検証する。

- **署名強度の必須化**:
  - `date` または `(created)` のいずれかが署名対象ヘッダに含まれていること。
  - POST リクエストでは `digest` が署名対象ヘッダに含まれていること。
- **Digest 検証**:
  - `Digest` ヘッダーから SHA-256 値を取得し、未加工ボディ (`req.rawBody`、無ければ `req.body`) の
    SHA-256 ダイジェスト (Base64) と一致することを検証する。
  - ヘッダー欠落・未対応アルゴリズム・ダイジェスト不一致は 403 で拒絶する。
- **時刻有効期限チェック (Time Window)**:
  - `Date` または `(created)` からリクエスト時刻を取得し、未来方向許容幅を 1 時間 (`CLOCK_SKEW_MARGIN`)、
    過去方向許容幅を 13 時間 (`EXPIRATION_WINDOW_LIMIT` 12 時間 + 許容幅 1 時間) とする。
  - `expires` パラメータがある場合は `min(expires, created + 12h) + 1h` を上限とし、範囲外は 403 で拒絶する。

## 理由

- Mastodon 実装 (`signed_request.rb`) の仕様・定数に合わせることで連合互換性を維持し改ざんを防ぐ。
- ±30秒〜数分などの狭い許容幅は配信キュー遅延やクロックスキューで誤検知を生むため、13時間を許容する。
- JSON-LD compaction 後のオブジェクトでは元バイト列と一致しないため、`rawBody` から計算する。

## 結果

- ボディ改ざんや過去署名の再送リプレイが 403 で確実に拒絶され、セキュリティ要件を満たす。
- Mastodon / Misskey 等からの正当なアクティビティ受信は引き続き正常に行われる。

## 参照

- 関連 Issue: [#136](https://github.com/hakatashi/activitypub-firebase/issues/136)
- 関連 ADR: [[ADR-0042]], [[ADR-0044]]
- 参考実装: `third_party/mastodon/app/lib/signed_request.rb`
