# ADR-0138: IRI と Mastodon ID の対応をインスタンス内にキャッシュする

- **Status:** Accepted
- **Date:** 2026-10-21

## 背景

Issue #350。ホームのタイムライン(`limit=20`)1 回あたりの読み取り約 169 回のうち、約 40 回が
`mastodonIdsByIri` である。Status の組み立てのたびに、Note・リプライ先・アカウントの Mastodon ID を
`findMastodonIds` で引き直しており、クライアントの自動更新ではほぼ同じ IRI を毎回読んでいる。
`mastodonIds` / `mastodonIdsByIri` は採番時に `create` / `set` で一度書くだけで、書き換え・削除する経路が無い。

## 決定

1. **キャッシュ:** `findMastodonIds`(IRI → ID)と `getIriByMastodonId`(ID → IRI)は、まずインスタンスの
   メモリにある対応を使い、無いものだけを Firestore から読む。読めた対応は両方向に覚える。
   **値が変わらないので無効化はしない。**
2. **上限:** 両方向あわせて 20,000 対応まで(1 対応あたり数百バイトで、数 MB 程度)。超えたら最も長く
   使われていないものから捨てる(LRU)。
3. **採番した直後:** `getOrAssignMastodonId` はトランザクションのコミットが成功した後に、その対応を覚える。
   コミット前に覚えると、競合で再試行されたときに使われなかった ID を返してしまう。
4. **未採番は覚えない。** 見つからなかった IRI・ID は後で採番されうる。
5. **トランザクション内の読み取りにはキャッシュを使わない。** `getOrAssignMastodonIdInTransaction` や
   射影の採番は、従来どおりトランザクションで読む(競合の検出をトランザクションの読み取りに頼っているため)。
6. 射影のエントリのドキュメント ID(ADR-0136)を既知の ID として渡す案や、`objects` の `_meta` に
   ID を持たせる案は採らない。キャッシュだけでウォームなインスタンスの読み取りはほぼ 0 回になり、
   残るのはコールドスタート直後の分だけである。

## 理由

- 値が不変なので、ADR-0135 のようなバージョンの読み取りすら要らず、古い値を返す心配が無い。
- Note・リプライ先・アカウントのすべてと、タイムライン以外のエンドポイント(`statuses/:id` など)にも効く。
- 利用者は 1 人で、よく表示する IRI は数千件に収まるので、上限付きのメモリで足りる。

## 結果

- ウォームなインスタンスでは、タイムライン 1 ページあたり約 40 回の読み取りが減る。
- コンソールで `mastodonIds` / `mastodonIdsByIri` を手で書き換えると、インスタンスが入れ替わるまで古い対応が残る。
  手で直したときは Functions を再デプロイする。
- テストではエミュレータを消すたびにキャッシュも消す(`resetFirestore`)。

## 参照

- 関連 Issue: [#350](https://github.com/hakatashi/activitypub-firebase/issues/350) / 関連 ADR: [ADR-0058](0058-mastodon-id-snowflake-layout.md), [ADR-0135](0135-cache-following-by-projection-version.md), [ADR-0136](0136-fan-out-home-and-list-timelines-on-write.md)
