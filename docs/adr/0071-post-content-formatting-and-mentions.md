# ADR-0071: 投稿本文の解析・自動変換とメンション解決

- **Status:** Accepted
- **Date:** 2026-10-05

## 背景

`POST /api/v1/statuses` は本文を段落に分けるだけで、URL・メンション・ハッシュタグを
解釈しなかった (Issue #160, [[ADR-0063]])。そのため direct 投稿が宛先なしになり、
リモートへの配送や通知も行われず、Status の `mentions` / `tags` も空だった。

## 決定

1. **純粋関数による本文解析・HTML 生成 (`statusContent.ts`)**:
   - `extractEntities` で URL・ハッシュタグ・メンションの位置と値を重複なく抽出する。
   - `formatPostContent` は解決済みメンションの対応表を受け取り、HTML と Note 用の `tag` 配列、
     宛先 actor IRI 群を純粋関数の形で生成する。
2. **HTML 変換の仕様**:
   - URL: `rel="nofollow noopener noreferrer" target="_blank"` 付き `<a>` タグとし、
     Mastodon と同じ prefix / ellipsis / suffix の span 構造とする。
   - ハッシュタグ: `<a href="https://${mastodonDomain}/tags/:tag" class="mention hashtag" rel="tag">#<span>:tag</span></a>`。
   - メンション: 解決できたものは `<span class="h-card" translate="no"><a href=":url" class="u-url mention">@<span>:display</span></a></span>`。
     未解決のものや危険な URL スキーム (XSS 防止) はプレーンテキストとして残す。
3. **リモート actor の WebFinger 解決 (`webfinger.ts`)**:
   - リモートメンション (`@user@host`) は `https://${host}/.well-known/webfinger` を SSRF セーフ
     ([[ADR-0050]]) かつホスト一致検証 (RFC 7033 §7) 付きで取得し、`self` リンクの IRI を得る。
   - 取得した IRI を `apex.resolveObject` で取得・保存し、ローカル actor 同様に対処する。
   - 自ホストのメンションは WebFinger を行わず直接ローカル DB を参照する。
4. **宛先 (`to` / `cc`) と Note `tag` への反映**:
   - Note の `tag` に `Mention` (`href` は actor IRI) と `Hashtag` を格納する。
   - Note の宛先 (`publishNote`) に解決済みメンションの actor IRI 群を渡し、
     [[ADR-0063]] で入れた「リプライ先投稿者の暫定追加」を置き換える。

## 理由

- 投稿本文の解析と HTML 生成を I/O のない純粋関数として切り離すことで、正規表現や
  エスケープ・省略表記の挙動を単体テストで網羅できる。
- SSRF 対策 ([[ADR-0050]]) を WebFinger クライアントにも適用することで、任意の内部 IP への
  リクエストを防ぐ。

## 結果

- メンションしたリモート/ローカルユーザーへ正しく Note が配送・通知される。
- direct 投稿でもメンション相手が `to` に入り、Status の `content`、`mentions`、`tags` も正常に反映される。

## 参照

- 関連 Issue: [#160](https://github.com/hakatashi/activitypub-firebase/issues/160)
- 関連 ADR: [[ADR-0050]], [[ADR-0063]], [[ADR-0069]]
