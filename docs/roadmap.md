# ロードマップ

**進捗はここに書かない。** 各 Epic Issue を参照すること。このファイルはフェーズの構成と
依存関係だけを示す。

## 最終目的

1. 完全サーバーレスな ActivityPub 実装。運用費用と管理の手間を極力抑える。
2. Mastodon 互換 API を提供し、サードパーティクライアントから一通りの操作ができる。
3. `hakatashi.com` を個人サイトと共用したソーシャルアイデンティティ。
4. `@hakatashi@pawoo.net` からの引っ越し。

## フェーズ

| # | フェーズ | Epic | ゴール |
|---|---|---|---|
| 0 | 開発基盤 | [#5](https://github.com/hakatashi/activitypub-firebase/issues/5) | エージェントが迷わず着手でき、依存が現行世代で、ログに秘密情報がない |
| 1 | 配送 | [#6](https://github.com/hakatashi/activitypub-firebase/issues/6) | **実在の Mastodon インスタンスへ投稿が届く** |
| 2 | 受信と AP 準拠 | [#7](https://github.com/hakatashi/activitypub-firebase/issues/7) | 仕様の MUST を満たし、相互運用で静かに壊れない |
| 3 | Mastodon API | [#8](https://github.com/hakatashi/activitypub-firebase/issues/8) | **Elk から投稿・閲覧が一通りできる** |
| 4 | リッチ機能 | [#9](https://github.com/hakatashi/activitypub-firebase/issues/9) | 通知・メディア・検索など実用機能が揃う |
| 5 | 引っ越し | [#10](https://github.com/hakatashi/activitypub-firebase/issues/10) | pawoo.net から移行し、フォロワーが追従する |

## 依存関係と順序の理由

```
Phase 0 ──┐
          ├─→ Phase 1 ──→ Phase 2 ──┐
          │   (配送)      (受信)      ├─→ Phase 4 ──→ Phase 5
          └─────────────→ Phase 3 ───┘   (機能)      (引っ越し)
                          (API)
```

- **Phase 1 が最優先。** 配送が動かなければ、投稿しても Accept を返しても外に出ない。
  他のどの機能を積んでも「動いている」ことにならない。
- **Phase 2 と Phase 3 は並行できる。** 前者は連合の正しさ、後者はクライアント体験であり、
  触る層が違う。ただし Phase 4 のアンフォロー実装は Phase 2 の Store メソッド実装に依存する。
- **Phase 5 は最後。** 引っ越しは30日クールダウンがありやり直せない。移行直後に
  フォロワーの各サーバーから大量の `Follow` が届くため、配送が確実に動いていることが絶対条件。
  日常利用に耐える状態(Phase 3, 4)を作ってから行う。

## Issue の運用ルール

- 各フェーズに Epic Issue を1本置き、子 Issue をタスクリストで束ねる。
- **子 Issue はそのフェーズに着手する時点で作成する。** 全フェーズ分を先に作らない。
- ラベルは `phase:N` と `area:*` を付ける。着手前に ADR が必要なものには `needs-adr` を付ける。
- 設計判断が発生したら、実装より先に [`adr/`](adr/) に ADR を追加する。
