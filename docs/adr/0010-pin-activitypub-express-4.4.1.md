# ADR-0010: activitypub-express を 4.4.1 に固定する

- **Status:** Accepted
- **Date:** 2026-09-04

## 背景

Issue #12(依存関係の一括アップグレード)の作業中、`activitypub-express` の最新版
4.4.2(現時点の最新)を試したところ、`test/integration/activitypub.spec.ts` の
「3 users registered」テストが不安定になった。

原因を追ったところ、4.4.2 は `pub/nodeinfo.js` の `getUserCount()` にモジュールグローバルな
24時間キャッシュを追加していた。公式 CHANGELOG によれば、これは
"can help limit query targeting warnings from mongo" とあり、MongoDB バックエンドで
発生するクエリ警告を抑えるための変更である。4.4.1→4.4.2 の差分はこれ1点のみで、他の
差分はすべて CRLF 化によるノイズであり、セキュリティ修正・バグ修正は含まれない。

## 決定

**`activitypub-express` を `4.4.1` に固定する(キャレット無し)。** 4.4.2 以降には上げない。

## 理由

- キャッシュが対処する問題(MongoDB のクエリターゲティング警告)は Firestore を自前実装で
  使うこのプロジェクトには存在しない([ADR-0002](0002-keep-activitypub-express.md))。恩恵がない。
- 一方で副作用は残る。単一ユーザー想定のこのインスタンスでも actor 作成直後に
  `/nodeinfo` のユーザー数が最大24時間古くなり得る。実害は軽微だが、
  テストの前提(作成後は即座にカウントへ反映される)と食い違う。
- 4.4.2 が現時点の最新版であり、これより新しいバージョンで解消される見込みもない。

## 結果

- `functions/package.json` の `activitypub-express` はキャレット無し `"4.4.1"` で固定する。
  Dependabot 等が自動で 4.4.2 以降に上げないよう、更新提案が来たら本 ADR を確認して却下する。
- 将来 apex 側でこのキャッシュを無効化するオプションが追加された場合、または
  Firestore Store 側でクエリ負荷が問題になった場合は、本 ADR を Supersede して見直す。

## 参照

- [[ADR-0002]] activitypub-express を継続利用し、配送層のみ差し替える
- `functions/package.json`
- 関連 Issue: [#12](https://github.com/hakatashi/activitypub-firebase/issues/12)
