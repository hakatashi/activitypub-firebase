# ActivityPub S2S 準拠状況

[ActivityPub 仕様](../third_party/activitypub/index.html)のうち、サーバー間(S2S)のやりとりに関わる規範的要件
(MUST / MUST NOT / SHOULD / SHOULD NOT)を条文単位で並べ、こちらの実装の対応を記録する。
`docs/mastodon-api-coverage.md` の ActivityPub 版。**該当する実装を変えたらこの表を更新する。**

- 判定は推測ではなく、コード・テスト・本番への GET(2026-10-22)で確認した事実に基づく。
- §B Security Considerations は、大半が小文字の should(非規範)である。S2S に関わるものを参考として載せる。
- 対象外: C2S(outbox への POST。Mastodon API で代替している → [ADR-0004](adr/0004-no-custom-ui-use-elk.md))と、
  Mastodon 独自拡張(`Move` など)。C2S の節(§6)の要件は、S2S の節から参照されているものだけを載せる。

凡例: ✅ 準拠 / ➖ 例外規定により不要・該当なし / ⚠️ 意図的に非準拠(ADR あり) / ❌ 非準拠・未実装(Issue あり)

コードのパスは `functions/src/` からの相対パス。

## §3 オブジェクト

| 節 | 要件 | 水準 | 判定 | 根拠 |
|---|---|---|---|---|
| §3 | オブジェクトに ActivityPub の `@context` を含める | SHOULD | ✅ | `apex/pub/consts.ts` の `ASContext`、`apex.ts` の `context`。本番の actor の `@context` で確認 |
| §3 | 受け取った内容を検証し、なりすましを防ぐ | SHOULD | ❌ | HTTP 署名と署名者 = `actor` の検証、`Update` / `Delete` / `Undo` のオリジン検証はある([ADR-0044](adr/0044-self-implemented-http-signature-in-apex-fork.md)、[ADR-0046](adr/0046-validate-owner-same-origin-in-apex.md))。**`Create` / `Announce` に埋め込まれた別オリジンのオブジェクトをそのまま保存する** → [#362](https://github.com/hakatashi/activitypub-firebase/issues/362) |
| §3.1 | 配布するオブジェクトは一意のグローバルな `id` を持つ(一時的なものを除く) | MUST | ✅ | `apex/pub/activity.ts` の `buildActivity`、`notes.ts` の `publishNote`(`utils.objectIdToIRI`) |
| §3.1 | `id` は公開で参照可能な URI で、authority は発信元のサーバー。公開のものは HTTPS | MUST / SHOULD | ✅ | `routes.ts`(`/activitypub/u` / `o` / `s`)を `activitypub.ts` で GET できる。インポートした投稿も新ドメインで振り直す([ADR-0126](adr/0126-import-post-history-from-mastodon-archive.md)) |
| §3.1 | S2S のアクティビティは `id` を持つ(一時的なものを除く) | MUST | ✅ | `buildActivity` が必ず `id` を振る |
| §3.2 | `Accept: application/ld+json; profile="…activitystreams"` に AS の表現を返す | MUST | ✅ | `apex/net/validators.ts` の `jsonld`、`apex/net/responders.ts`。本番で 200 と同じ `Content-Type` を確認 |
| §3.2 | `Accept: application/activity+json` にも AS の表現を返す | SHOULD | ✅ | 同上(`apex/pub/consts.ts` の `jsonldTypes`) |
| §3.2 | 取得する側は `Accept` に `application/ld+json; profile=…` を指定する | MUST | ✅ | `apex/pub/federation.ts` の `requestObject`(`apex/pub/consts.ts` の `jsonldAcceptType`)。相互運用のため `application/activity+json` も併記する。`test/unit/apex/requestObject.spec.ts` |
| §3.2 | 認可に失敗した要求は適切なコード(または 403)で失敗させる。存在を隠すなら 404 でもよい | SHOULD / MAY | ✅ | `apex/net/security.ts` の `requireAuthorizedOrPublic` が公開でないオブジェクト・アクティビティに 403。GET の HTTP 署名による認可はしないので、非公開のものは誰にも返さない |

## §4 actor

| 節 | 要件 | 水準 | 判定 | 根拠 |
|---|---|---|---|---|
| §4 | UI に入力された actor の ID を正規化する | SHOULD | ➖ | UI(クライアント)の要件。こちらの UI は Elk / Phanpy |
| §4.1 | actor は `inbox` と `outbox` を持つ | MUST | ✅ | `apex/pub/actor.ts` の `createActor`。本番の actor で確認 |
| §4.1 | actor は `following` と `followers` を持つ | SHOULD | ✅ | 同上 |
| §4.1 | `sharedInbox` は公開の `OrderedCollection` で、`Public` 宛て以外を見せない | SHOULD / MUST NOT | ➖ | `endpoints.sharedInbox` を提供していない(MAY) |

## §5 コレクション

| 節 | 要件 | 水準 | 判定 | 根拠 |
|---|---|---|---|---|
| §5 | 仕様の `OrderedCollection` は常に新しい順に示す | MUST | ✅ | `store/index.ts` の `getStream` はアクティビティの Mastodon ID(`published` 基準)の降順で、ページのカーソルも同じキー([ADR-0146](adr/0146-order-streams-by-activity-mastodon-id.md))。`test/unit/store.spec.ts` |
| §5.1 | outbox は `OrderedCollection` | MUST | ✅ | `apex/pub/collection.ts` の `buildCollection` / `getOutbox` |
| §5.2 | inbox は `OrderedCollection` | MUST | ✅ | 同上(`getInbox`) |
| §5.2 | inbox の中身を要求者の権限で絞る | SHOULD | ✅ | `getCollection` は認可がなければ公開のものだけを返す。`test/integration/inbox-public.spec.ts` |
| §5.2 | inbox が返すアクティビティを `id` で重複除去する | MUST | ✅ | `streams` は `id` をキーに 1 件だけ持つ([ADR-0049](adr/0049-save-activity-return-contract-and-inbox-dedup.md))。`test/integration/inbox-dedup.spec.ts` |
| §5.2 | 連合しないサーバーは inbox への POST に 405 | SHOULD | ➖ | 連合するサーバーである |
| §5.3 | actor は followers を持ち、`Collection` か `OrderedCollection` | SHOULD / MUST | ✅ | `getFollowers`。承認した Follow を公開にして匿名でも読める([ADR-0035](adr/0035-mark-accepted-follow-as-public.md))。`test/integration/inbox-follow-public.spec.ts` |
| §5.4 | actor は following を持ち、`Collection` か `OrderedCollection` | SHOULD / MUST | ✅ | `getFollowing`。`Accept` の受信で追加する(§7.6) |
| §5.5 | liked は `Collection` か `OrderedCollection`(liked 自体は MAY) | MUST | ❌ | 型は満たすが、お気に入りの `Like` を入れておらず常に空 → [#365](https://github.com/hakatashi/activitypub-firebase/issues/365) |
| §5.6 | `Public` には配送しない | MUST NOT | ✅ | `apex/pub/activity.ts` の `address` が `as:Public` を飛ばす。宛先表現は JSON-LD 処理で `as:Public` に正規化する([ADR-0045](adr/0045-normalize-public-address-in-apex-jsonld.md)) |
| §5.7 / §5.8 | likes / shares は `Collection` か `OrderedCollection`(いずれも MAY) | MUST | ✅ | アクティビティには `buildActivity` が付ける。Note には付けず、件数は `_meta` のカウンタで持つ([ADR-0037](adr/0037-denormalize-like-announce-counts.md)) |

## §7 サーバー間のやりとり

| 節 | 要件 | 水準 | 判定 | 根拠 |
|---|---|---|---|---|
| §7 | 送るアクティビティは `id` を持つ | SHOULD | ✅ | `buildActivity` |
| §7 | POST の `Content-Type` は `application/ld+json; profile=…` | MUST | ✅ | `apex/pub/federation.ts` の `deliver`(`jsonldOutgoingType`)。`test/unit/apex/deliver.spec.ts` |
| §7 | GET の `Accept` は `application/ld+json; profile=…` | MUST | ✅ | §3.2 と同じ |
| §7 | `application/activity+json` を同じものとして解釈する | SHOULD | ✅ | `jsonldTypes`(`validators.jsonld` と `activitypub.ts` の本文の解析) |
| §7 | `Create` / `Update` / `Delete` / `Follow` / `Like` / `Block` / `Undo` に `object`、`Add` / `Remove` に `target` を付けて配送する | MUST | ✅ | `buildActivity` の呼び出し元(`notes.ts`、`social/follows.ts`、`social/reactions.ts`、`mastodon/routes/statusActions.ts`、`mastodon/routes/accounts.ts`)はすべて `object` を渡す。ピン留め・解除時の `Add` / `Remove` は `target` (`featured`) と `object` を付けてフォロワーへ配送する (→ [ADR-0160](adr/0160-featured-collection-and-pins-delivery.md))。`Block` は送らない |
| §7 | HTTP のキャッシュ(RFC 7234)を、受け取る側・送る側の両方で尊重する | SHOULD | ❌ | 応答には `ETag` が付き条件付き GET に 304 を返すが、リモートの取得は `Cache-Control` / `ETag` を見ない → [#366](https://github.com/hakatashi/activitypub-firebase/issues/366) |
| §7.1 | 配送先を `to` / `bto` / `cc` / `bcc` / `audience` から決める | — | ✅ | `apex/pub/utils.ts` の `audienceFromActivity` |
| §7.1 | 宛先がコレクションなら参照して各要素の inbox を探す | MUST | ✅ | `address`。自分の followers はローカルで展開する。リモートのコレクションは埋め込みの `items` / `orderedItems` だけを見る(投稿でリモートのコレクションを宛先にすることはない) |
| §7.1 | コレクションをたどる段数を制限する(1 段でもよい) | MUST | ✅ | `address` は 1 段だけ展開する([ADR-0120](adr/0120-batch-resolve-address-destinations.md)) |
| §7.1 | 最終的な配送先を重複除去する | MUST | ✅ | `address` の末尾の `Set`。`test/unit/apex/activity.spec.ts` の `de-dupes shared inboxes` |
| §7.1 | アクティビティの actor 自身を配送先から除く | MUST | ❌ | 通常の配送は送信者の inbox を除く(`activity.spec.ts`)。**inbox からの転送では、転送するアクティビティの actor(リモート)を除かない** → [#361](https://github.com/hakatashi/activitypub-firebase/issues/361) |
| §7.1 | 配送先は宛先の actor の `inbox` | — | ⚠️ | 宛先の種類によらず sharedInbox を優先する([ADR-0142](adr/0142-prefer-shared-inbox-for-all-recipients.md)) |
| §7.1 | 送信するユーザーの認可を付けて POST する | — | ✅ | actor の鍵で HTTP 署名する(`deliver`、keyId は `#main-key` → [ADR-0015](adr/0015-fix-http-signature-keyid-fragment.md)) |
| §7.1 | 連合しないサーバーへの配送は 405 になる | SHOULD | ➖ | 受信側の要件。連合するサーバーである |
| §7.1 | 配送は非同期に行い、ネットワークエラーなら再試行する | SHOULD | ✅ | Cloud Tasks の `deliveryTask`(`tasks.ts`、[ADR-0003](adr/0003-delivery-via-cloud-tasks.md)、[ADR-0114](adr/0114-retry-transient-delivery-failures.md))。`test/unit/tasks.spec.ts` |
| §7.1.1 | outbox に入ったアクティビティを、actor が所有する個人・コレクションの宛先へ配送する | SHOULD | ✅ | Mastodon API からの投稿は `apex.addToOutbox` → `publishActivity` で配送する。自分の followers とカスタムコレクションを展開する |
| §6(§B.11 から参照) | 配送の前に `bto` / `bcc` を取り除く。宛先の決定には使う | MUST | ✅ | `apex/pub/utils.ts` の `stringifyPublicJSONLD` が入れ子も含めて取り除く。`audienceFromActivity` は `bto` / `bcc` を含む |
| §7.1.2 | 次の 3 条件がすべて成り立つときだけ、`to` / `cc` / `audience` へ転送する: 初めて見たアクティビティ・宛先に自サーバーのコレクション・`inReplyTo` などが自サーバーのオブジェクト | MUST | ✅ | `apex/net/activity.ts` の `forwardFromInbox`。`test/integration/inbox-forwarding.spec.ts` が 3 条件それぞれを確認する |
| §7.1.2 | 自サーバーのオブジェクトを探すとき再帰し、上限を設ける | SHOULD | ✅ | `apex/pub/federation.ts` の `resolveReferences`(深さ 5・件数 10・循環検出 → [ADR-0055](adr/0055-resolve-references-limits-and-cycle-detection.md))。`test/unit/apex/federation.spec.ts` |
| §7.1.2 | 元のアクティビティの `to` / `cc` / `audience` だけを宛先にし、再帰中に宛先を拾わない | MUST | ✅ | `forwardFromInbox` は元のアクティビティの 3 つのプロパティだけを見る |
| §7.1.3 | フォロワーへの配送で、同じ sharedInbox の宛先をまとめてよい | MAY | ✅ | `address`。`activity.spec.ts` |
| §7.1.3 | sharedInbox を持たない宛先には個別に配送する | MUST | ✅ | `address` は sharedInbox がなければ `inbox` を使う |
| §7.2 | `Create` を受け取ったらアクティビティとオブジェクトを保存する(規範的な要件はない) | — | ✅ | `activity.save`(埋め込みの検証は §3 → [#362](https://github.com/hakatashi/activitypub-firebase/issues/362)) |
| §7.3 | `Update` で同じ `id` の手元のコピーを丸ごと置き換える | SHOULD | ✅ | `inboxSideEffects` の `update` → `store.updateObject(object, actorId, true)`。`test/integration/inbox-origin-check.spec.ts` |
| §7.3 | `Update` がそのオブジェクトを変えてよいか確かめる(少なくとも同一オリジン) | MUST | ✅ | `apex/pub/utils.ts` の `validateOwner`([ADR-0046](adr/0046-validate-owner-same-origin-in-apex.md))。`inbox-origin-check.spec.ts` |
| §7.4 | `Delete` で(送信者の所有なら)手元の表現を消す。Tombstone に置き換えてよい | SHOULD / MAY | ✅ | `inboxSideEffects` の `delete`(`buildTombstone`)。所有の検証は `validateOwner`。`inbox-origin-check.spec.ts` |
| §6.4(§7.4 から参照) | 削除したオブジェクトの GET は、Tombstone を返すなら 410、そうでなければ 404 | SHOULD | ✅ | `apex/net/responders.ts` の `sendJsonLd` が Tombstone に 410 |
| §7.5 | `Follow` に `Accept` か `Reject` を返す | SHOULD | ✅ | `activitypub.ts` の `apex-inbox` リスナー → `social/follows.ts` の `acceptAndPublishFollow`(自動承認。[ADR-0111](adr/0111-retry-unaccepted-follow-and-500-on-sync-failure.md)) |
| §7.6 | 自分が送った `Follow` への `Accept` で、相手を following に加える | SHOULD | ✅ | `inboxSideEffects` の `accept`。送った Follow かを `validateOwner(follow, recipient)`、承認したのが相手かを `validators.inboxActivity` で確かめる |
| §7.7 | `Reject` を受けたら following に加えない | MUST NOT | ✅ | `inboxSideEffects` の `reject` は following から外す。`test/integration/inbox-follow-no-collection-update.spec.ts` |
| §7.8 / §7.9 | `Add` / `Remove` で object を target に追加・削除する(target が自サーバーの所有でない・裁量で許可しないときを除く) | SHOULD | ➖ | 例外規定に当たるものとして副作用を行わない([ADR-0141](adr/0141-ignore-inbox-add-remove.md))。ただし object が Note だと 400 を返している → [#363](https://github.com/hakatashi/activitypub-firebase/issues/363) |
| §7.10 | `Like` を、object に likes があれば likes に加える | SHOULD | ✅ | `inboxSideEffects` の `like`。Note は likes を持たない(「あれば」の例外)ので `_meta` のカウンタで数える([ADR-0037](adr/0037-denormalize-like-announce-counts.md)、[ADR-0047](adr/0047-resolve-like-announce-object-in-apex.md))。`test/integration/inbox-like-announce-object.spec.ts` |
| §7.11 | `Announce` を、object に shares があれば shares に加える | SHOULD | ✅ | 同上(`announce`) |
| §7.12(§6.10 を参照) | `Undo` と取り消すアクティビティは同じ actor | MUST | ✅ | `validators.inboxActivity` の `requiresObjectOwnership`。`test/integration/inbox-undo.spec.ts` の 403 のケース |
| §7.12(§6.10 を参照) | 副作用をできるだけ取り消す | should | ✅ | `store.removeActivity` がコレクションから外し、カウンタを戻す([ADR-0123](adr/0123-resolve-undo-follow-by-actor-and-collection.md))。`inbox-undo.spec.ts` |
| §6.9 | `Block` をその object へ配送しない | SHOULD NOT | ➖ | `Block` を送らない |

inbox からの転送は、元の署名ではなくローカル actor の鍵で署名し直して送る(`forwardFromInbox` → `publishActivity`)。
転送の認証方法は仕様が定めていないので表には載せない。受信側は署名者とアクティビティの actor が違うため、Mastodon は `id` から取り直す。

## §B セキュリティ(参考)

| 節 | 内容 | 水準 | 判定 | 根拠 |
|---|---|---|---|---|
| §B.1 | サーバー間の認証 | — | ✅ | HTTP Signatures(draft-cavage と RFC 9421)の検証と生成([ADR-0044](adr/0044-self-implemented-http-signature-in-apex-fork.md)、[ADR-0056](adr/0056-verify-digest-and-date-window-in-http-signature.md)、[ADR-0057](adr/0057-support-rfc-9421-via-standard-library.md))。外部への GET にも署名する([ADR-0098](adr/0098-sign-outgoing-get-with-local-actor.md)) |
| §B.2 | 内容が本当にその actor のもので、actor に変更の権限があるか確かめる | should | ❌ | 署名者 = `actor` は `validators.actor`、権限は `validateOwner`。埋め込みのオブジェクトは §3 と同じ → [#362](https://github.com/hakatashi/activitypub-firebase/issues/362) |
| §B.3 | 本番で localhost への要求を許さない(許すなら既定で無効の設定にする) | should | ✅ | `apex/pub/ssrf.ts` の既定は `unicast` のみ。ループバックはエミュレータ・テストのときだけ許す(`apex.ts` の `remoteFetchPolicy`、[ADR-0050](adr/0050-ssrf-safe-request-object-in-apex.md))。`test/unit/apex/ssrf.spec.ts` |
| §B.4 | 安全な URI スキーム(http / https)だけを許す | should | ✅ | `ssrf.ts` の既定は `https:` のみ。`@context` の取得も同じ([ADR-0054](adr/0054-ssrf-safe-jsonld-context-loader.md)) |
| §B.5 | オブジェクトをたどる再帰の深さを制限する | should | ✅ | `resolveReferences`([ADR-0055](adr/0055-resolve-references-limits-and-cycle-detection.md))、`address` の 1 段の展開 |
| §B.6 | スパムを選別する | recommended | — | 仕組みはない。シングルユーザーで、相手の actor のブロック(`blockList`)だけがある |
| §B.7 | 連合の DoS に備える。送信は指数バックオフなどで相手を過負荷にしない | should / SHOULD | ✅ | 送信は Cloud Tasks の指数バックオフ(`maxDoublings: 4`)と `rateLimits`(`tasks.ts`)。受信のレート制限はない |
| §B.10 | ブラウザで描画するフィールドをサニタイズする | should | ✅ | Mastodon API は `Status.content`・`Account.note`・`fields` の値を応答時に Mastodon の `MASTODON_STRICT` と同じ許可リストでサニタイズする(`mastodon/sanitizeHtml.ts`、[ADR-0145](adr/0145-sanitize-html-in-mastodon-api-responses.md))。表示名・`spoiler_text` は Mastodon と同じくプレーンテキストとして返す。リンクプレビュー用の HTML は `mastodon/publicPageHtml.ts` がサニタイズする。`test/unit/sanitizeHtml.spec.ts` |
| §B.11 | `bto` / `bcc` を表示しない | should | ✅ | ActivityPub の応答は `stringifyPublicJSONLD` で取り除く。Mastodon API の応答に `bto` / `bcc` は出ない |

## 対象外にしたもの

- **C2S(§6 の outbox への POST)。** `activitypub.ts` は apex の outbox POST のルートをつないだままだが、`security.requireAuthorized` が
  PassportJS 形式の認証(`req.user`)を要求し、それを設定する仕組みがないので常に 403 になる(仕様は C2S を実装しないサーバーに 405 を勧めている)。
- **Mastodon 独自拡張。** `Move` は 2xx で受け取って捨てる([ADR-0115](adr/0115-inbox-4xx-only-for-sender-faults.md)、#305)。
