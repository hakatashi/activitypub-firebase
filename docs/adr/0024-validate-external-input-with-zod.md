# ADR-0024: 外部から来る入力は zod で検証する

- **Status:** Accepted
- **Date:** 2026-09-06

## 背景

[[ADR-0022]] と [[ADR-0023]] は「apex の出力」と「Firestore に保存済みのデータ」について
ランタイム検証を行わないと決めた。これらは自分たちが型を保証できる境界の内側にある。
一方、**クライアントと外部サービスから来る入力には、型を保証する根拠が何もない。**

現状これらはキャストで素通りしている。`mastodon/oauth.ts:22` の
`(await response.json()) as { apps: { appId: string }[] }` と `:34` の
`as Record<string, any>` は Firebase Management API のレスポンスを未検証で信用しており、
API の仕様変更やエラーレスポンスが返った場合に、型が付いたまま `undefined` が下流へ流れる。

## 決定

**`zod`(v4)を `functions` の dependencies に追加し、以下の境界で必ず検証する。**

1. Mastodon 互換 API のクエリパラメータとリクエストボディ(`functions/src/mastodon/api.ts`)
2. OAuth のリクエスト(`functions/src/mastodon/oauth.ts`、認可・トークン両エンドポイント)
3. **外部 HTTP レスポンス**(Firebase Management API など、`fetch` の結果すべて)
4. Cloud Tasks のペイロード(`functions/src/tasks.ts`)。自前で作った値だが、デプロイを跨いで
   キューに残った古い形式が届きうる

検証しない境界も明示する。**inbox に届く AP のリクエストボディは apex に任せ、二重に検証しない**
(→ [[ADR-0022]])。Firestore からの読み出しも検証しない(→ [[ADR-0023]])。

**zod スキーマから `z.infer` で起こした型を Firestore のスキーマ型として流用しない。**
Firestore は型のみ、外部入力は zod、と役割を分ける。

## 理由

- 検証しない境界を ADR で決めた以上、「どこは検証するのか」を同じ強さで決めておかないと、
  結局すべてが「たぶん大丈夫」で素通りする。
- zod は失敗を値(`safeParse`)で返せるため、Mastodon API が返すべき 400 と、
  外部 API 障害として扱うべき 5xx を呼び出し側で書き分けられる。
- 二重管理の禁止を明記するのは、`z.infer` は便利すぎて Firestore 側にも広がりやすく、
  そうなると [[ADR-0023]] の「読み書きで型を分ける」判断と衝突するため。

## 結果

- Cloud Functions のコールドスタートに zod のロード分が加算される。実測して問題になれば
  `zod/mini` に切り替える。
- 外部 API のレスポンス形式が変わった場合、これまで静かに `undefined` が流れていた箇所が
  明示的なエラーになる。挙動としては変化であり、ログとハンドリングの追加が必要になる。

## 参照

- [[ADR-0022]], [[ADR-0023]]
- `functions/src/mastodon/api.ts`, `functions/src/mastodon/oauth.ts`, `functions/src/tasks.ts`
