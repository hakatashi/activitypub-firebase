# ロードマップ

**進捗はここに書かない。** オープンな Issue を参照すること。このファイルは最終目的と進め方だけを示す。

## 最終目的

1. 完全サーバーレスな ActivityPub 実装。運用費用と管理の手間を極力抑える。
2. Mastodon 互換 API を提供し、サードパーティクライアントから一通りの操作ができる。
3. `hakatashi.com` を個人サイトと共用したソーシャルアイデンティティ。
4. `@hakatashi@pawoo.net` からの引っ越し。

**4つとも達成した。** 引っ越しは 2026-10-17 15:43:45Z に pawoo.net で `Move` を実行し、
72時間後の時点で、移れるはずのフォロワー 187 人のうち 152 人(81%)が移ってきた
(pawoo.net をブロックしている misskey.io の 17 人を除くと 170 人中 152 人で 89%。内訳は
[#273](https://github.com/hakatashi/activitypub-firebase/issues/273))。
手順と、本番で起きたことは [`runbooks/account-migration.md`](runbooks/account-migration.md) にある。

## 進め方: 継続改善

最終目的の達成をもってプロジェクトは一区切りとし、以後は互いに独立した改善を Issue 単位で進める
(→ [ADR-0130](adr/0130-continuous-improvement-after-phase5.md))。

- 次に何をするかは、オープンな Issue の一覧が担う。
- 優先順位は Issue ごとに判断する。ただし**連合を壊さないこと(配送・受信・WebFinger)を機能追加より常に優先する。**
- 大きな機能で複数の Issue を束ねたくなった場合は、その機能単位の親 Issue に sub-issue をぶら下げてよい。
- 設計判断が発生したら、実装より先に [`adr/`](adr/) に ADR を追加する。

Issue の起票のルールは [`AGENTS.md`](../AGENTS.md) を参照。
