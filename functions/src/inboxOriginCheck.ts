import assert from 'node:assert';
import type { APObject } from 'activitypub-express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { apex } from './apex.js';

// apex がリクエストごとに res.locals.apex へ積む値のうち、ここで扱うもの
// (inboxDedup.ts の ApexLocals と同様のパターン)。
interface ApexLocals {
	activity?: boolean;
	actor?: APObject;
	object?: APObject;
	status?: number;
	statusMessage?: string;
	[key: string]: unknown;
}

const isApexLocalsSet = (value: unknown): value is ApexLocals =>
	typeof value === 'object' && value !== null;

type InboxRequest = Request<Record<string, string>, unknown, APObject>;

const requiresSameOrigin = new Set(['update', 'delete']);

const originOf = (id: string): string | undefined => {
	try {
		return new URL(id).origin;
	} catch {
		return undefined;
	}
};

const isSameOrigin = (actorId: string, objectId: string): boolean => {
	const actorOrigin = originOf(actorId);
	const objectOrigin = originOf(objectId);
	return actorOrigin !== undefined && actorOrigin === objectOrigin;
};

// apex.net.inbox.post の validators.inboxActivity の直後(activity.save の直前)に挿入する。
// ActivityPub 仕様は Update / Delete について、署名者がその object を変更する権限を持つことの
// 最低限の確認として同一オリジン検証を要求する。apex の validateOwner は object.attributedTo /
// object.actor を見るが、Update の object は攻撃者が inbox リクエストにインラインで埋め込んだ
// 値であり、これらのフィールド自体が自己申告にすぎない。ここでは HTTP 署名検証済みの
// 署名者 id と object.id を直接比較することで、自己申告に依存しない検証を行う(→ ADR-0031)。
export const verifySameOriginForUpdateDelete: RequestHandler = (
	req: InboxRequest,
	res: Response,
	next: NextFunction,
) => {
	const resLocal = isApexLocalsSet(res.locals.apex) ? res.locals.apex : undefined;
	const activity = req.body;
	const type = typeof activity.type === 'string' ? activity.type.toLowerCase() : undefined;
	if (!resLocal?.actor || type === undefined || !requiresSameOrigin.has(type)) {
		next();
		return;
	}
	const object = resLocal.object;
	if (object?.id === undefined) {
		next();
		return;
	}
	if (!isSameOrigin(resLocal.actor.id, object.id)) {
		resLocal.activity = false;
		resLocal.status = 403;
		resLocal.statusMessage = `${activity.type} actor origin does not match object origin`;
	}
	next();
};

// apex.net.inbox.post 相当の配列(または既に他のミドルウェアが挿入済みの配列)に、
// validators.inboxActivity の参照を目印として同一オリジン検証ミドルウェアを挿入したものを返す。
// apex 本体のミドルウェア自体は変更しない(→ ADR-0031)。
export const insertSameOriginCheckForUpdateDelete = (
	original: RequestHandler[],
): RequestHandler[] => {
	const inboxActivityIndex = original.indexOf(apex.net.validators.inboxActivity);
	assert(
		inboxActivityIndex !== -1,
		'apex.net.validators.inboxActivity not found in inbox post middleware chain',
	);
	return [
		...original.slice(0, inboxActivityIndex + 1),
		verifySameOriginForUpdateDelete,
		...original.slice(inboxActivityIndex + 1),
	];
};
