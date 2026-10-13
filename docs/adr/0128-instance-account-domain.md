# ADR-0128: インスタンス情報で account_domain を返し、acct のドメインを ActivityPub 側に揃える

- **Status:** Accepted
- **Date:** 2026-10-13

## 背景

ActivityPub (WebFinger) のドメインは `hakatashi.com`、Mastodon API のドメインは
`mastodon.hakatashi.com` と分かれている。ローカルアカウントの `acct` は Mastodon の仕様どおり
ドメインなしの `hakatashi` を返しているため、Elk はドメイン部を補う際に
API サーバーのホスト名を使い、プロフィールに実在しないアドレス `@hakatashi@mastodon.hakatashi.com`
を表示していた。

Elk の `getInstanceDomain()` は、インスタンス情報に GoToSocial 拡張の `account_domain` が
あればそれを、なければ `domain` を使う(`third_party/elk/app/composables/users.ts`)。
Mastodon 本体は同様のケース (`LOCAL_DOMAIN` ≠ `WEB_DOMAIN`) で `domain` に `LOCAL_DOMAIN`
を返すが、Elk はログイン時のサーバー指定に API のホスト名を使うので、`domain` を変えると
他の箇所との整合性が崩れるおそれがある。

## 決定

- `/api/v2/instance` に `account_domain: <ActivityPub のドメイン>` を追加する。`domain` は
  API のドメインのまま変えない。
- `acct` はドメインなしのまま変えない(Mastodon の仕様どおり)。

## 結果

- Elk ではハンドルが `@hakatashi@hakatashi.com` と表示される。
- `account_domain` を解さないクライアントでは従来どおり API のドメインで補われる。
