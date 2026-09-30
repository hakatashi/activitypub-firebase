import type { NextFunction, Request, Response } from 'express';
import { errorMessage } from '../values.js';
import { getApex, getLocals } from './locals.js';

const acctReg = /acct:[@~]?(?<user>[^@]+)@?(?<domain>.*)/;

export const respondNodeInfo = async (req: Request, res: Response): Promise<void> => {
	const apex = getApex(req);
	try {
		const version = req.params.version || '2.1';
		if (version[0] !== '2') {
			res.status(404).send('Only nodeinfo 2.x supported');
			return;
		}
		res.json(await apex.generateNodeInfo(version));
	} catch (err) {
		console.error('Error generating nodeInfo', errorMessage(err));
		res.sendStatus(500);
	}
};

export const respondNodeInfoLocation = (req: Request, res: Response): void => {
	const apex = getApex(req);
	res.json({
		links: [
			{
				rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1',
				href: `${apex.baseUrl}/nodeinfo/2.1`,
			},
			{
				rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0',
				href: `${apex.baseUrl}/nodeinfo/2.0`,
			},
		],
	});
};

export const parseWebfinger = (req: Request, res: Response, next: NextFunction): void => {
	const apex = getApex(req);
	const acct = acctReg.exec(String(req.query.resource));
	const user = acct?.groups?.user;
	if (!user) {
		res
			.status(400)
			.send(
				'Bad request. Please make sure "acct:USER@DOMAIN" is what you are sending as the "resource" query parameter.',
			);
		return;
	}
	const domain = acct.groups?.domain;
	if (domain && domain.toLowerCase() !== apex.domain.toLowerCase()) {
		res.status(400).send('Requested user is not from this domain');
		return;
	}
	// store as actor param for validators.targetActor api
	req.params[apex.actorParam] = user;
	next();
};

export const respondWebfinger = (req: Request, res: Response): void => {
	const { resource } = req.query;
	const actorObj = getLocals(res).target;
	if (!actorObj) {
		res.status(404).send(`${String(resource)} not found`);
		return;
	}
	res.json({
		subject: resource,
		links: [
			{
				rel: 'self',
				type: 'application/activity+json',
				href: actorObj.id,
			},
		],
	});
};
