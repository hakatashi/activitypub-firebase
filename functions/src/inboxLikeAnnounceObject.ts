import type { APObject } from 'activitypub-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { apex } from './apex.js';
import type { ApexLocals } from './utils.js';
import { parseApexLocals, toIdArray } from './utils.js';

// req.body.object は Like/Announce にしか無く APObject には型付けされていないため、
// この境界ファイル限定で緩めた型を使う (→ ADR-0026 の「型キャストは境界ファイルに閉じ込める」)。
type InboxRequest = Request<Record<string, string>, unknown, APObject & { object?: unknown }>;

const LIKE_ANNOUNCE_TYPES = new Set(['like', 'announce']);

// apex.net.inbox.post の validators.activityObject の直後・validators.inboxActivity の
// 直前に挿入する。apex は Like/Announce の object を「actor を持つ別のアクティビティ」と
// してしか解決・受理しない (net/validators.js の needsResolveActivity / requiresActivityObject)。
// しかし Mastodon を含む実際の実装は Like.object / Announce.object に投稿 (Note) 自身の
// IRI を指定してくる。Note は attributedTo を持つが actor は持たないため
// apex.validateActivity の形状チェックを満たせず、常に 400 "Activity type object requried"
// で拒否され、Like/Announce が一切保存されない
// (実地検証: mastodon-test.hakatashi.com からの Like/Announce で確認 → Issue #55)。
//
// resolveActivity による解決が失敗している場合、対象を通常のオブジェクトとして
// apex.resolveObject で再解決し、attributedTo を actor として複製したコピーに差し替える。
// apex.validateOwner は元々 attributedTo も見る実装 (pub/utils.js) のため、
// 所有権判定への影響はない (→ ADR-0038)。
export const resolveLikeAnnounceObjectAsPlainObject: RequestHandler = (
	req: InboxRequest,
	res: Response,
	next: NextFunction,
) => {
	const activity = req.body;
	const type = typeof activity.type === 'string' ? activity.type.toLowerCase() : undefined;
	if (type === undefined || !LIKE_ANNOUNCE_TYPES.has(type)) {
		next();
		return;
	}

	const resLocal = parseApexLocals(res.locals.apex);
	if (apex.validateActivity(resLocal.object)) {
		next();
		return;
	}

	const objectId = toIdArray(activity.object)[0];
	if (objectId === undefined) {
		next();
		return;
	}

	apex
		.resolveObject(objectId, true)
		.then((resolved) => {
			const attributedTo = toIdArray(resolved.attributedTo);
			if (attributedTo.length > 0) {
				const apexLocals = res.locals.apex as ApexLocals;
				// actor は APObject には無いフィールドだが、apex.validateActivity は
				// ランタイムで存在確認するだけなので実害はない (→ ADR-0038)。
				apexLocals.object = { ...resolved, actor: attributedTo } as APObject;
			}
		})
		.catch(() => {
			// 解決できなければ何もしない。validators.inboxActivity が 400 を返す。
		})
		.finally(next);
};
