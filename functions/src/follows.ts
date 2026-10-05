import { escapeFirestoreKey } from './firebase.js';
import { metaIndexPath } from './meta.js';
import { Streams } from './schema.js';

// 同じ actor から同じ相手への Follow が複数残ると、followers コレクションに同じ actor が
// 重複して並ぶ (→ ADR-0075)。新しい Follow を受理するとき、置き換えられる古い Follow を消す。
// Mastodon の Undo は最新の Follow の IRI を指すため、古い Follow が残ると Undo しても
// フォロワーのまま残ってしまう問題も防げる。
export const removeSupersededFollows = async (
	actorId: string,
	objectId: string,
	keepFollowId: string,
): Promise<number> => {
	const docs = await Streams.where('type', '==', 'Follow')
		.where(metaIndexPath('actors', escapeFirestoreKey(actorId)), '==', true)
		.where(metaIndexPath('objects', escapeFirestoreKey(objectId)), '==', true)
		.get();
	const stale = docs.docs.filter((doc) => doc.data().id !== keepFollowId);
	await Promise.all(stale.map((doc) => doc.ref.delete()));
	return stale.length;
};
