# ADR-0078: 単一ユーザー前提のローカルアクター設定の集約

- **Status:** Accepted
- **Date:** 2026-10-06

## 背景

当インスタンスは単一ユーザー (`@hakatashi@hakatashi.com`) 前提で運用されているが、
ユーザー名、表示名、プロフィール文、アイコン URL、連絡先/許可メールアドレス、
および actor IRI の組み立て文字列が `functions/src` や `functions/bin` の各所に直書きされていた。
また、actor IRI のパス規則 (`/activitypub/u/:actor`) は `apex.ts` の `routes.actor` にもあり、
二重管理となっていた。
データモデルのマルチユーザー対応方針 (ADR-0005) を維持しつつ、設定の不整合を防ぐため集約が必要である。

## 決定

1. **ActivityPub ルート定義の切り出し**
   - `functions/src/routes.ts` に ActivityPub のエンドポイントルート定義を集約し、`apex.ts` から参照する。
2. **ローカルアクター設定モジュールの新設**
   - `functions/src/localActor.ts` を作成し、以下を集約する:
     - ユーザー名 (`hakatashi`)、表示名、自己紹介文、アイコン URL
     - 連絡先/許可メールアドレス (`hakatasiloving@gmail.com`)
     - `routes` と `domain` から actor / followers / following / inbox / outbox 等の IRI を生成する純粋関数および定数
3. **副作用のない設計**
   - `localActor.ts` は `firebase.ts` (ドメイン定義) と `routes.ts` のみに依存し、apex や Firestore インスタンス化の副作用を持たせない。
4. **既存のハードコード箇所の置換**
   - `functions/src` および `functions/bin` の各所から `localActor.ts` を参照するように置換する。

## 結果

- actor IRI やローカルユーザー属性の直書きが排除され、ルート変更時にも IRI 生成が自動的に追従する。
- 許可メールアドレスおよび公開連絡先メールアドレスの定義が1箇所に集約される。
- バッチスクリプトやテスト等からも安全にインポート可能になる。

## 参照

- 関連 Issue: [#188](https://github.com/hakatashi/activitypub-firebase/issues/188), [#181](https://github.com/hakatashi/activitypub-firebase/issues/181)
- 関連 ADR: [ADR-0005](0005-single-user-multi-ready-data-model.md), [ADR-0042](0042-apex-fork-responsibility-boundary.md)
