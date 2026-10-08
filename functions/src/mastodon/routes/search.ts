import express from 'express';
import type { APActor } from 'activitypub-types';
import { z } from 'zod';
import { search, SEARCH_TYPES } from '../../social/search.js';
import type { SearchOptions } from '../../social/search.js';
import { getAttributedTo } from '../../utils.js';
import {
	AuthenticationError,
	authIfPresent,
	authRequired,
	getAuthActorId,
	getLocalActor,
	scopeRequired,
} from '../http/auth.js';
import { toBoolean } from '../http/params.js';
import { getValidQuery, validate } from '../http/validation.js';
import { resolveActorIriByAccountId, userIdsToAccounts } from '../presenters/account.js';
import { notesToStatuses } from '../presenters/status.js';

// アカウント検索と、URL・acct からのリモートの解決 (→ ADR-0097)。
const router = express.Router();

const booleanParam = z
	.union([z.boolean(), z.string()])
	.optional()
	.transform((value) => toBoolean(value) === true);

const integerParam = z.coerce.number().int().optional().catch(undefined);

const baseSearchQuerySchema = z.object({
	q: z.string(),
	resolve: booleanParam,
	following: booleanParam,
	limit: integerParam,
	offset: integerParam,
});

export const searchQuerySchema = baseSearchQuerySchema.extend({
	type: z.enum(SEARCH_TYPES).optional().catch(undefined),
	account_id: z.string().optional(),
});

export const accountSearchQuerySchema = baseSearchQuerySchema;

const SEARCH_LIMITS = { defaultLimit: 20, maxLimit: 40 };
const ACCOUNT_SEARCH_LIMITS = { defaultLimit: 40, maxLimit: 80 };

const clampLimit = (limit: number | undefined, { defaultLimit, maxLimit }: typeof SEARCH_LIMITS) =>
	Math.max(1, Math.min(limit ?? defaultLimit, maxLimit));

const getViewer = (res: express.Response): Promise<APActor | undefined> =>
	typeof res.locals.actorId === 'string'
		? getLocalActor(getAuthActorId(res))
		: Promise.resolve(undefined);

router.get(
	'/v2/search',
	authIfPresent('read:search'),
	validate({ query: searchQuerySchema }),
	async (req, res) => {
		const query = getValidQuery(res, searchQuerySchema);
		const viewer = await getViewer(res);

		// 未認証の呼び出しで外部へのリクエストを起こさせない (Mastodon と同じく 401。→ ADR-0097)。
		if (viewer === undefined && query.resolve) {
			throw new AuthenticationError(
				'Search queries that resolve remote resources are not supported without authentication',
			);
		}
		if (viewer === undefined && query.offset !== undefined) {
			throw new AuthenticationError(
				'Search queries pagination is not supported without authentication',
			);
		}

		const options: SearchOptions = {
			type: query.type,
			resolve: query.resolve,
			following: query.following,
			limit: clampLimit(query.limit, SEARCH_LIMITS),
			// Mastodon と同じく、offset は type の指定があるときだけ効く。
			offset: query.type === undefined ? 0 : Math.max(0, query.offset ?? 0),
			viewer,
		};
		const result = await search(query.q, options);

		let { notes } = result;
		if (query.account_id !== undefined) {
			const authorIri = await resolveActorIriByAccountId(query.account_id);
			notes = notes.filter((note) => getAttributedTo(note) === authorIri);
		}

		const [accounts, statuses] = await Promise.all([
			userIdsToAccounts(result.actorIris),
			notesToStatuses(notes, viewer),
		]);
		res.json({ accounts, statuses, hashtags: [] });
	},
);

router.get(
	'/v1/accounts/search',
	authRequired,
	scopeRequired('read:accounts'),
	validate({ query: accountSearchQuerySchema }),
	async (req, res) => {
		const query = getValidQuery(res, accountSearchQuerySchema);
		const viewer = await getLocalActor(getAuthActorId(res));
		const result = await search(query.q, {
			type: 'accounts',
			resolve: query.resolve,
			following: query.following,
			limit: clampLimit(query.limit, ACCOUNT_SEARCH_LIMITS),
			offset: Math.max(0, query.offset ?? 0),
			viewer,
		});
		res.json(await userIdsToAccounts(result.actorIris));
	},
);

export default router;
