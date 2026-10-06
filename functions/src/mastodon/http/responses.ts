import type express from 'express';
import { mastodonDomain } from '../../firebase.js';
import { buildLinkHeader } from '../pagination.js';
import type { StatusEntity } from '../presenters/status.js';

// 絶対 URL の Link ヘッダを組み立てて付ける。`ids` は応答の並び (新しい順)。
export const setLinkHeader = (req: express.Request, res: express.Response, ids: string[]) => {
	const link = buildLinkHeader(
		`https://${mastodonDomain}${req.baseUrl}${req.path}`,
		req.query,
		ids,
	);
	if (link !== undefined) {
		res.set('Link', link);
	}
};

export const respondWithStatuses = (
	req: express.Request,
	res: express.Response,
	statuses: StatusEntity[],
) => {
	setLinkHeader(
		req,
		res,
		statuses.map((status) => status.id),
	);
	res.json(statuses);
};
