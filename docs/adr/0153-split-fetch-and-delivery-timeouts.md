# ADR-0153: 外部への取得と配送のタイムアウトを分け、配送の再試行を延ばす

- **Status:** Accepted
- **Date:** 2026-10-23

## 背景

apex の外部への HTTP リクエストは、署名者・オブジェクト・`@context` の取得、WebFinger、配送のすべてが
`requestTimeout`(既定の 5 秒)を使っていた。2026-10-17 の Move の直後、応答が 1〜10 秒に遅くなっていた
pawoo.net の actor の取得が 5 秒でタイムアウトし、inbox が 500 を 84 件返した(#273、#326)。
配送の再試行は `maxAttempts: 5`(間隔 10・20・40・80 秒)で、相手の不調が3分ほど続くと尽きる。

## 決定

1. apex フォークの設定に **`deliveryTimeout`** を足し、`apex.deliver` はこれを使う(省略時は `requestTimeout`)。
   取得(`requestObject`・`jsonldContextLoader`・WebFinger)は従来どおり `requestTimeout` を使う。
2. `functions/src/apex.ts` で **`requestTimeout: 8000`**、**`deliveryTimeout: 15000`** を設定する。
3. `deliveryTask` の **`maxAttempts` を 5 から 8 にする**(ADR-0114 の 4. を supersede する)。
   バックオフの設定(`minBackoffSeconds: 10`、`maxDoublings: 4`)は変えず、
   間隔は 10・20・40・80・160・320・480 秒、初回から最後の試行まで約 18 分になる。

## 理由

- 取得の多くは inbox の処理の中で起きる。送信側の Mastodon は inbox への POST を `read_timeout: 10` 秒で打ち切る
  (`third_party/mastodon/app/lib/request.rb`)ので、取得1回で 10 秒を使い切らない 8 秒にする。
  2026-10-17 に観測した pawoo.net の最大(7.7 秒)は収まる。
- 配送は Function のタイムアウト(60 秒)の中で1件だけを送るので、inbox のような制約がない。
  Mastodon の外部への取得(`read_timeout: 10`、`read_deadline: 30`)の間を取って 15 秒にする。
- undici の `headersTimeout` / `bodyTimeout` はそれぞれの待ちの上限なので、1回の取得はこれより長くかかりうる。
  inbox の応答が多少遅れても、相手の再送はこちらの重複検出(ADR-0049)で吸収される。
- 再試行を延ばすと、一時的な不調が十数分続いても配送を落とさない。永久に死んでいる相手への無駄な試行は
  1件あたり3回増えるだけで、`maxDispatchesPerSecond` の範囲で流れる。

## 結果

- 遅い相手でも取得・配送が失敗しにくくなる代わりに、負荷が集中したときの inbox と `deliveryTask` の
  待ち時間の上限が延びる。
- `deliveries` の `attempts` が 8 に達した `retrying` を実質的な失敗と読む。

## 参照

- 関連 ADR: [[0114-retry-transient-delivery-failures]]、[[0115-inbox-4xx-only-for-sender-faults]]、[[0049-save-activity-return-contract-and-inbox-dedup]]
- 関連 Issue: [#326](https://github.com/hakatashi/activitypub-firebase/issues/326)、[#273](https://github.com/hakatashi/activitypub-firebase/issues/273)
