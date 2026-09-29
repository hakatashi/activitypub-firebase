import type { Request, Response } from 'express';
import type { APObject } from '../types.js';
import { getApex, getLocals } from './locals.js';

const sendJsonLd = async (req: Request, res: Response, body: APObject | null | undefined) => {
	const apex = getApex(req);
	const locals = getLocals(res);
	if (locals.status !== undefined && locals.status >= 400) {
		res.status(locals.status).send(locals.statusMessage || null);
		return;
	}
	if (!locals.responseType || !body) {
		res.sendStatus(404);
		return;
	}
	const serialized = apex.stringifyPublicJSONLD(await apex.toJSONLD(body));
	res.type(locals.responseType);
	res.status(body.type === 'Tombstone' ? 410 : 200).send(serialized);
};

// sends other output as jsonld
export const result = (req: Request, res: Response): Promise<void> =>
	sendJsonLd(req, res, getLocals(res).result);

export const status = (_req: Request, res: Response): void => {
	const locals = getLocals(res);
	if (locals.createdLocation) {
		res.set('Location', locals.createdLocation);
	}
	res.status(locals.status ?? 400).send(locals.statusMessage || null);
};

// sends the target object as jsonld
export const target = (req: Request, res: Response): Promise<void> =>
	sendJsonLd(req, res, getLocals(res).target);
