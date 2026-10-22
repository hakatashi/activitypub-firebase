# ADR-0142: 配送は宛先の種類によらず相手の sharedInbox を優先する

- **Status:** Accepted
- **Date:** 2026-10-22

## 背景

Issue #317 で ActivityPub 仕様の S2S 部分を条文単位で照合した。§7.1 は配送先を「宛先の actor の `inbox`」としている。
§7.1.3 Shared Inbox Delivery が sharedInbox への集約を認めている(MAY)のは、
**送信者のフォロワーへの配送**と、**`Public` 宛ての配送**の 2 つの場合だけである。

apex フォークの `address`(`functions/src/apex/pub/activity.ts`)は、宛先の actor が `endpoints.sharedInbox` を持っていれば、
宛先の種類によらず `inbox` の代わりに sharedInbox へ送る。メンションだけを宛先にした投稿(direct)や、`Follow` / `Accept` / `Like` / `Undo` など特定の actor 宛てのアクティビティも同じである。
この挙動の理由を記録した ADR はなかった。

## 決定

**配送先は、宛先の種類(フォロワー経由か、個別の actor か)によらず、相手が sharedInbox を持っていればそちらを使い、なければ `inbox` を使う。** 今の実装を維持する。
同じ sharedInbox になる宛先はまとめて 1 回だけ配送する。sharedInbox を持たない宛先には個別の `inbox` へ送る(§7.1.3 の MUST)。

## 理由

- Mastodon も、投稿の配送ではメンションの宛先(direct を含む)にも sharedInbox を使う
  (`third_party/mastodon/app/lib/status_reach_finder.rb` の `inboxes` は `Account#preferred_inbox_url` = sharedInbox があればそれ、なければ inbox)。
  `Follow` / `Like` / `Accept` は個人の `inbox` に送る(`follow_service.rb` など)が、Mastodon / Misskey の sharedInbox はこれらも受け付け、
  本文の宛先(`to` / `cc` / `object` など)から受け取る actor を決めるので、相互運用上の問題は起きていない。
- 同じサーバーの複数の宛先への配送が 1 回にまとまり、Cloud Tasks のタスク数と相手のサーバーの負荷が減る。
- 個別の宛先だけ `inbox` に送るよう分けると、同じアクティビティが同じサーバーの sharedInbox と個人の inbox の両方に届き、受信側の重複除去に頼ることになる。

## 結果

- §7.1 の「配送先は actor の `inbox`」を、sharedInbox について文字どおりには守らない。`docs/activitypub-s2s-compliance.md` では「意図的に非準拠」と判定する。
- sharedInbox の扱いを変えるときは、この ADR を supersede する。

## 参照

- 関連 ADR: [[0003-delivery-via-cloud-tasks]]、[[0120-batch-resolve-address-destinations]]
- 関連 Issue: [#317](https://github.com/hakatashi/activitypub-firebase/issues/317)
