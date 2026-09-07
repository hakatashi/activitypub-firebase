import type { APObject } from 'activitypub-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isAPUndo, parseApexLocals } from './utils.js';

type InboxRequest = Request<Record<string, string>, unknown, APObject>;

// apex.net.inbox.post の activity.save の直前に挿入する。
// apex の save は denormalizeObject ('create', 'announce', 'like', 'add', 'reject') のみ
// res.locals.apex.object を activity.object に埋め込んで保存するが、undo は含まない。
// 文字列 IRI で届いた Undo の object を解決済みオブジェクト (res.locals.apex.object) で
// 埋め込んでから保存させることで、非同期トリガー onStreamCreated が確実に対象の Follow を
// 判定できるようにする (→ ADR-0033)。
export const denormalizeUndoObject: RequestHandler = (
	req: InboxRequest,
	res: Response,
	next: NextFunction,
) => {
	const resLocal = parseApexLocals(res.locals.apex);
	if (!resLocal.activity || !resLocal.object) {
		next();
		return;
	}
	const activity = req.body;
	if (isAPUndo(activity)) {
		activity.object = [resLocal.object];
	}
	next();
};
