# ADR-0039: `statuses_count` の非正規化を `Create` ストリームだけに限定する

- **Status:** Accepted
- **Date:** 2026-09-08

## 背景

[ADR-0038](0038-resolve-like-announce-object-as-plain-object.md) の対応後、dev 環境で
`mastodon-test.hakatashi.com` から実際に Like/Announce を送って実地検証したところ、
`onStreamCreated` トリガーが Firestore の `NOT_FOUND: No document to update:
.../userInfos/<リモートアクターの IRI>` で失敗し、[ADR-0037](0037-denormalize-like-announce-counts.md)
の `_meta.likesCount` / `sharesCount` の更新も(同じ batch に含まれるため)巻き添えで
失敗することを発見した。

原因は `functions/src/denormalizations.ts` の `onStreamCreated` にある既存コード:

```ts
const isNote = objects.some(isAPNote);
if (isNote && actorId !== undefined) {
  batch.update(UserInfos.doc(escapeFirestoreKey(actorId)), {
    statuses_count: firebase.firestore.FieldValue.increment(1),
  });
}
```

`isNote` は「ストリームの `object` に Note 型のオブジェクトが埋め込まれているか」だけを見ており、
ストリーム自身の `type` が `Create` かどうかを見ていない。apex 本体の `activity.save`
(`pub/activity.js` の `denormalizeObject = ['create', 'announce', 'like', 'add', 'reject']`)は
`Like` / `Announce` についても解決済みの `object` を埋め込んで保存する。[ADR-0038](0038-resolve-like-announce-object-as-plain-object.md)
より前は Like/Announce の object 解決が常に失敗し 400 で拒否されていたため
(保存されないため)この分岐が誤発火することはなかったが、ADR-0038 で解決できるようになった
結果、**投稿への Like/Announce のたびに、投稿者ではなく「いいねした側のリモートアクター」の
`statuses_count` を増やそうとして `UserInfos` ドキュメントが存在せず失敗する**、
という潜在バグが顕在化した。

`batch.commit()` は原子的なため、この失敗により **同じ batch に含まれる
`_meta.likesCount` / `sharesCount` の更新も一緒に失われる**。

## 決定

**`statuses_count` の非正規化条件に `stream.type` が `Create` であることを追加する。**

```ts
const isCreate = toTypeArray(stream.type).includes('Create');
const isNote = isCreate && objects.some(isAPNote);
```

## 理由

- 「投稿(Note の作成)によって投稿者の statuses_count が増える」という本来の意図に対し、
  「Note を object として embed している任意のストリーム」は広すぎる条件だった。
  `Create` に限定することで意図どおりの条件になる。
- 副作用として、Like/Announce のたびに無関係なリモートアクターの `UserInfos` を
  作成・更新する必要もなくなる(単一ユーザー運用の本アプリでは `UserInfos` は
  自分自身のみが持つ設計であり、リモートアクター分を作る意図はない)。

## 結果

- `functions/src/denormalizations.ts` の `onStreamCreated` を修正する。
- Like/Announce ストリームの作成が `statuses_count` を誤って増やそうとせず、
  `_meta.likesCount` / `sharesCount` の更新が失われないことをテストで固定する。

## 参照

- [[0037-denormalize-like-announce-counts]]
- [[0038-resolve-like-announce-object-as-plain-object]]
- 関連 Issue: [#55](https://github.com/hakatashi/activitypub-firebase/issues/55)
