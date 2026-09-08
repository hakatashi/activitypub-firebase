import type { APObject } from 'activitypub-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { apex } from './apex.js';

import type { ApexLocals } from './utils.js';
import { parseApexLocals } from './utils.js';

type InboxRequest = Request<Record<string, string>, unknown, APObject>;

// apex.net.inbox.post の activity.save の直前に挿入する。今回配送された宛先コレクション
// (activity._meta.collection[0]、宛先 inbox の IRI)が、DB に保存済みの既存アクティビティの
// _meta.collection に既に含まれているかを調べ、res.locals.apex.isRedundantDelivery に記録する。
// apex 本体の save はこの区別ができず、常に isNewActivity を 'new collection' にしてしまう
// (→ ADR-0030)。
export const markRedundantInboxDelivery: RequestHandler = (
	req: InboxRequest,
	res: Response,
	next: NextFunction,
) => {
	const resLocal = parseApexLocals(res.locals.apex);
	if (!resLocal.activity || !resLocal.target) {
		next();
		return;
	}
	const activity = req.body;
	const newTarget = activity._meta?.collection?.[0];
	if (newTarget === undefined) {
		next();
		return;
	}
	apex.store
		.getActivity(activity.id, true)
		.then((existing) => {
			(res.locals.apex as ApexLocals).isRedundantDelivery = (
				existing?._meta?.collection ?? []
			).includes(newTarget);
			next();
		})
		.catch(next);
};

// apex.net.inbox.post の activity.save の直後に挿入する。markRedundantInboxDelivery で
// 記録した判定を使って isNewActivity を補正する(→ ADR-0030)。
export const correctIsNewActivity: RequestHandler = (req, res, next) => {
	const resLocal = parseApexLocals(res.locals.apex);
	if (resLocal.isRedundantDelivery && resLocal.isNewActivity === 'new collection') {
		(res.locals.apex as ApexLocals).isNewActivity = false;
	}
	next();
};
