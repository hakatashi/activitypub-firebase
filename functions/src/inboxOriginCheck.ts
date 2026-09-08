import type { APObject } from './apex/index.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { ApexLocals } from './utils.js';
import { parseApexLocals } from './utils.js';

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
	const resLocal = parseApexLocals(res.locals.apex);
	const activity = req.body;
	const type = typeof activity.type === 'string' ? activity.type.toLowerCase() : undefined;
	if (!resLocal.actor || type === undefined || !requiresSameOrigin.has(type)) {
		next();
		return;
	}
	const actorId = typeof resLocal.actor.id === 'string' ? resLocal.actor.id : undefined;
	const object = resLocal.object;
	const objectId = typeof object?.id === 'string' ? object.id : undefined;
	if (actorId === undefined || objectId === undefined) {
		next();
		return;
	}
	if (!isSameOrigin(actorId, objectId)) {
		const apexLocals = res.locals.apex as ApexLocals;
		apexLocals.activity = false;
		apexLocals.status = 403;
		apexLocals.statusMessage = `${activity.type} actor origin does not match object origin`;
	}
	next();
};
