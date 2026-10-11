# Gemini (Antigravity CLI) 向け環境設定・注意事項

このドキュメントでは、Gemini (Antigravity CLI) が本プロジェクトでコマンドを実行する際の注意点について記載します。

## Node.js / npm / npx のパス解決について

### 注意点・現象
Antigravity CLI から `run_command` 等でシェルコマンドを実行する際、単に `npm` や `node`、`npx` を指定すると以下のようなエラーが発生する場合があります。

```bash
bash: line 1: npm: command not found
```

### 原因（Antigravity CLI 特有の動作）
* 本環境では Node.js や npm のバージョン管理に **asdf**（`~/.asdf`）が使用されています。
* 通常の対話型ターミナルではログイン／対話シェル起動スクリプトによって `PATH` に asdf のディレクトリが追加されますが、Antigravity CLI (Gemini) がコマンド実行のために立ち上げる非対話型サブシェルでは `~/.asdf/shims` や `~/.asdf/bin` が `PATH` に含まれていません。
* このため、Antigravity CLI から実行されるサブシェルでは `node` や `npm` が見つからずエラーとなります。これは Gemini (Antigravity CLI) 特有の実行環境に起因するものです。

### 対処方法
Antigravity CLI から `node`、`npm`、`npx` を伴うコマンドを実行する際は、コマンドの先頭で `PATH` に asdf のパスを明示的に指定してください。

```bash
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" <コマンド>
```

#### 例
```bash
# ビルド
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" npm --prefix functions run build

# 型チェック
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" npm --prefix functions run typecheck

# リント・フォーマットチェック
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" npm --prefix functions run lint
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" npm --prefix functions run format:check

# テスト実行
PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH" npm --prefix functions test
```
