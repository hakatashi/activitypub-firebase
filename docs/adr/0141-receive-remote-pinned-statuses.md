# ADR-0141: リモートアカウントのピン留めを `featured` コレクションと `Add` / `Remove` から取り込む

- **Status:** Accepted
- **Date:** 2026-10-22

## 背景

Issue #318。リモートアカウントのピン留めを受け取っておらず、`?pinned=true` は自分のアカウントでしか結果を返さない。
Mastodon / Misskey は actor の `featured` にピン留めの `OrderedCollection` を載せ、ピン留め・解除のたびに
`target` = `featured` の `Add` / `Remove` をフォロワーへ配送する。apex フォークは inbox の `Add` / `Remove` の
`object` に Activity を要求しており、Note を object にした `Add` / `Remove` を 400 で拒否していた。

## 決定

1. **フォーク側の修正は「`Add` / `Remove` の `object` を Activity に限らない」ことだけ** ([ADR-0042](0042-apex-fork-responsibility-boundary.md))。
   AS2 の `Add` / `Remove` の object は任意のオブジェクトで、これは素で使う全員に必要な修正である。inbox では object を
   手元の streams / objects から探すだけで、外部へは取りに行かない (`Remove` や対象外の `Add` で無駄な取得をしない)。
2. **ピン留めとして扱うかの判断と保存は本体側** (`social/remotePins.ts`)。`apex-inbox` で受けた `Add` / `Remove` のうち、
   `target` が送信者の `featured` と一致し、object の IRI が送信者と同じオリジンのものだけを扱う。それ以外は無視する。
   - `Add`: Note を手元から探し、なければ SSRF 対策済みの `requestObject` で取得し、`attributedTo` が送信者の
     Note であれば (手元になければ `saveObject` で保存して) ピン留めに加える。
   - `Remove`: ピン留めから外す。Note は取得しない。
3. **保存先はローカルと同じ `userInfos/{actor}/pins/{noteKey}`** (`{ noteIri, createdAt }`)。読み出し側は持ち主が
   ローカルかリモートかを区別せずに済む。`pinned` 属性 (閲覧者自身のピン留め) は閲覧者の `pins` しか見ないので影響しない。
   1 actor あたり最大 20 件とし、超える `Add` は無視する (`?pinned=true` の読み取り回数を抑える)。
4. **既存のピン留めは、プロフィール閲覧時に `featured` を取り直して同期する。** [ADR-0140](0140-backfill-remote-outbox-on-profile-view.md) の
   outbox と同じく、`GET /api/v1/accounts/:id`・`/lookup` でリモート actor を見たとき、`_meta.featuredFetchedAt` が無いか
   24 時間より古ければ `remoteActorRefreshTask` に `kind: 'featured'` で頼む。
   - 取得するのは `featured` 本体とその `first` の 1 ページだけ (Mastodon の `max_pages: 1` と同じ)。最大 20 件、
     外部へのリクエストは Note の取得を含めて 1 回のタスクで最大 10 回。actor と同じオリジンのものだけを取得する。
   - 埋め込みの Note は、同じオリジンから取得したコレクションの中にあり、`id` のオリジンと `attributedTo` が actor と
     一致すればそのまま使う (ADR-0140 と同じ)。IRI だけなら手元を探し、なければ取得する。
   - コレクションを取得できたときだけ、`pins` をその内容に置き換える (取得できなかった Note は外れる)。
     取得できなければ `pins` は変えず、`featuredFetchedAt` だけを更新して翌日の閲覧に任せる。
   - 並び順を保つため、同期で加えるピン留めの `createdAt` はコレクションの順に 1 ミリ秒ずつずらす。
5. `?pinned=true` は `createdAt` の新しい順に返す (Mastodon の `status_pins.id DESC` と同じ)。

## 理由

- 判定を本体側に置くと、`featured` という Mastodon 拡張の解釈をフォークに持ち込まずに済む。
- 同期をプロフィール閲覧に載せると、見られないアカウントのために外部へ取りに行かない (ADR-0104 / 0140 と同じ考え方)。

## 結果

- 初めて開いたプロフィールではピン留めが出ず、同期後に開き直すと出る。フォロー中の相手のピン留め・解除は即座に反映される。
- 注目のハッシュタグ (`Hashtag` の `Add` / `Remove`)、Mastodon の Collections 機能、自分のピン留めの配送 (#319) は扱わない。

## 参照

- 関連 Issue: [#318](https://github.com/hakatashi/activitypub-firebase/issues/318)、[#319](https://github.com/hakatashi/activitypub-firebase/issues/319)
- [[0042-apex-fork-responsibility-boundary]]、[[0080-social-domain-layer-and-dependency-direction]]、[[0104-remote-actor-counts-via-background-refresh]]、[[0140-backfill-remote-outbox-on-profile-view]]
