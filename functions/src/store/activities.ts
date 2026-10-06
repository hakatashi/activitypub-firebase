// `streams` に対する、apex の Store 契約に含まれないアプリ独自の操作。
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey } from '../firebase.js';
import { Streams } from '../schema.js';

// Follow は to/cc を持たないため apex.isPublic() が常に false になり、承認済みでも
// 匿名の followers コレクションから除外される。承認時にこのフラグを立てて上書きする
// (→ ADR-0035)。
export const markActivityPublic = async (activity: APObject) => {
	const activityRef = Streams.doc(escapeFirestoreKey(activity.id));
	await activityRef.update({ '_meta.isPublic': true });
};
