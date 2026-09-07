import assert from 'node:assert';
import type { APObject } from 'activitypub-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { apex } from './apex.js';
import { isAPUndo } from './utils.js';

// apex がリクエストごとに res.locals.apex へ積む値のうち、ここで扱うもの
// (inboxDedup.ts の ApexLocals と同様のパターン)。
interface ApexLocals {
	activity?: boolean;
	object?: APObject;
	[key: string]: unknown;
}

const isApexLocalsSet = (value: unknown): value is ApexLocals =>
	typeof value === 'object' && value !== null;

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
	const resLocal = isApexLocalsSet(res.locals.apex) ? res.locals.apex : undefined;
	if (!resLocal?.activity || !resLocal.object) {
		next();
		return;
	}
	const activity = req.body;
	if (isAPUndo(activity)) {
		activity.object = [resLocal.object];
	}
	next();
};

// apex.net.inbox.post 相当の配列(または既に他のミドルウェアが挿入済みの配列)に、
// activity.save の直前に Undo の非正規化ミドルウェアを挿入したものを返す。
// apex 本体のミドルウェア自体は変更しない (→ ADR-0033)。
export const insertUndoDenormalization = (original: RequestHandler[]): RequestHandler[] => {
	const saveIndex = original.indexOf(apex.net.activity.save);
	assert(saveIndex !== -1, 'apex.net.activity.save not found in inbox post middleware chain');
	return [...original.slice(0, saveIndex), denormalizeUndoObject, ...original.slice(saveIndex)];
};
