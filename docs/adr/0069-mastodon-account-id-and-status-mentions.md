# ADR-0069: アカウント ID の採番と Status mentions の実 ID 解決

- **Status:** Accepted
- **Date:** 2026-10-04

## 背景

Status の `mentions[].id` とリモートアカウントの `account.id` は、外部アカウント共通のプレースホルダ `'1'`
(`externalUserInfo`) 固定だった (Issue #57, #154)。複数のリモートアカウントが同一 ID となり、
クライアントがアカウントを区別できない。[[ADR-0058]] は全 AP IRI に Snowflake ID を振る方針を決めたが、
アカウント ID やメンションへの具体的な解決・適用経路が未定だった。

## 決定

1. **アカウント ID の体系**:
   - ローカルアカウントは `UserInfo.id` (`'1'` 等) を維持する。
   - リモートアカウントは `mastodonIds` / `mastodonIdsByIri` で採番した Snowflake ID とする。
2. **アカウント ID の一括解決 (`resolveAccountIds`)**:
   - 与えられた actor IRI 群に対し、まず `UserInfos` からローカルアカウントを引く。
   - 存在しない IRI (リモートアカウント) は `getMastodonIds` (未採番なら現在時刻で採番) で引いて結合する。
3. **`actorObjectToAccount` の改修**:
   - `id` 引数を受け取り `account.id` に設定する。`id` も `userInfo?.id` も無ければ `actor.id` から採番・取得する。
4. **`mentions[].id` の解決**:
   - `StatusContext` に `mentionIds` (IRI → Account ID マップ) を追加。
   - `noteToMentions` は Mention タグの `href` から実 ID を解決して `mentions[].id` に入れる。
5. **ステータス組み立て (`notesToStatuses`)**:
   - 投稿者 IRI と全 Note のメンション先 IRI を集めて `resolveAccountIds` で一括解決し、
     `userIdsToAccounts` および `StatusContext.mentionIds` に渡す。
6. **バックフィル (`assignMastodonIds.ts`)**:
   - 既存 Note の Mention タグの `href` も抽出し、未採番の actor IRI に Snowflake ID を振る。

## 理由

- ローカルユーザーは既存の単一ユーザー識別子 (`'1'`) を維持してクライアントのセッション破壊を防ぎ、
  リモートアカウントは時系列 Snowflake ID で一意にする。
- ステータス組み立て時に投稿者とメンション先を一括解決することで、Firestore への往復回数を最小化する。

## 結果

- リモートアカウントの投稿やメンションで正確なアカウント ID が返り、Elk 等でリモートユーザーの区別と
  プロフィール遷移が正常に動作する。

## 参照

- 関連 ADR: [[ADR-0006]], [[ADR-0058]], [[ADR-0060]], [[ADR-0065]]
- 関連コード: `functions/src/mastodon/api.ts`, `functions/src/mastodon/statusAttributes.ts`
