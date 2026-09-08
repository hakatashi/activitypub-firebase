# ADR-0041: apex のフォークは in-tree に置き、モノレポ化しない

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

[ADR-0040](0040-fork-activitypub-express.md) で apex をフォークすると決めた。
フォークの置き場所として3つの案があった。

1. GitHub の Fork 機能で別リポジトリとして持ち、npm の git 依存として参照する
2. pnpm などの workspace を導入し、`packages/apex` と `packages/functions` に分ける
3. `functions/src/apex/` にソースを直接置く (in-tree vendoring)

## 決定

**3 を採る。** フォークは `functions/src/apex/` に置き、既存の `tsc` / `oxlint` / `vitest` で
そのままビルド・検証する。**GitHub の Fork 機能は使わず、workspace も導入しない。**

MIT ライセンスの要求を満たすため、上流の `LICENSE` を保持し、
`functions/src/apex/NOTICE.md` に分岐元 (activitypub-express v4.4.1) を記録する。

## 理由

**GitHub の Fork を使わない理由。** フォーク関係が価値を生むのは「上流に追随する」か
「上流へ PR を送る」場合だけで、どちらも起きない(上流は2年停止、ADR-0010 で追随を放棄済み)。
一方でリポジトリが2つに割れると、**コーディングエージェントの作業単位も2つに割れる。**
このプロジェクトの実装は原則としてエージェントが行う(→ [ADR-0001](0001-use-lightweight-adrs.md))ため、
これは実質的なコストになる。

**workspace を導入しない理由。** `firebase.json` は `"source": "functions"` を指しており、
デプロイ時はこのディレクトリだけをアップロードして向こう側で `npm install` する。
workspace のシンボリックリンク依存はそのままでは解決できず、バンドラの導入か pack 相当の
前処理が要る。このリポジトリは現在 `tsc` のみでバンドラを持たないため、
**モノレポ化はデプロイパイプラインの改造とセットになる。**
一方、workspace で得たかったもの(単一チェックアウト、単一の build/lint/test)は
in-tree なら追加コストゼロで手に入る。

パッケージ境界(npm 公開、独立バージョニング)が必要になったら、そのとき workspace に
昇格すればよい。**先にモノレポ化するのは、まだ発生していない問題のために
デプロイパイプラインを壊すリスクを取ることになる。**

## 結果

- フォークを npm パッケージとして外部に公開する道は、当面閉じる。
- `functions/src/` の行数が約3000行増える。`src/apex/` とそれ以外の境界は
  ディレクトリと lint ルールで担保する(→ [ADR-0042](0042-apex-fork-responsibility-boundary.md))。
- 移行完了までは JS と TS が混在するため `allowJs` を一時的に有効にする。
  TS 化の完了時に外す。

## 参照

- [[ADR-0040]], [[ADR-0042]]
- `firebase.json`, `functions/tsconfig.json`
