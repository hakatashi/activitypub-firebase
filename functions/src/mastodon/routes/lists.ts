import express from 'express';
import { z } from 'zod';
import { mastodonDomain } from '../../firebase.js';
import {
	DEFAULT_LIST_REPLIES_POLICY,
	LIST_REPLIES_POLICIES,
	MAX_LIST_TITLE_LENGTH,
	addListAccounts,
	createList,
	deleteList,
	getList,
	getLists,
	getListsContaining,
	removeListAccounts,
	updateList,
} from '../../social/lists.js';
import type { ListAttributes } from '../../social/lists.js';
import { authRequired, getAuthActorId, scopeRequired } from '../http/auth.js';
import { NotFoundError, UnprocessableError } from '../http/errors.js';
import { loadAccount, loadViewer } from '../http/loaders.js';
import { toBoolean } from '../http/params.js';
import { respondWithStatuses } from '../http/responses.js';
import { parsePageParams } from '../pagination.js';
import { resolveActorIriByAccountId } from '../presenters/account.js';
import {
	LIST_ACCOUNTS_PAGE_LIMITS,
	getListAccountsPage,
	listToEntity,
} from '../presenters/list.js';
import { STATUS_PAGE_LIMITS, getListTimeline } from '../presenters/status.js';

// リスト (→ ADR-0134)。リストは認証ユーザー自身のものだけを扱い、他人のリストは存在しないものとして 404 を返す。
const router = express.Router();

const listBodySchema = z.object({
	title: z.unknown().optional(),
	replies_policy: z.unknown().optional(),
	exclusive: z.union([z.boolean(), z.string()]).nullable().optional(),
});

// Mastodon の `List` のバリデーションと同じ文言で 422 を返す。`requireTitle` が偽なら、無いキーは変えない。
const parseListAttributes = (body: unknown, requireTitle: boolean): Partial<ListAttributes> => {
	const parsed = listBodySchema.safeParse(body ?? {});
	if (!parsed.success) {
		throw new UnprocessableError('Validation failed: Exclusive is invalid');
	}
	const { title, replies_policy: repliesPolicy, exclusive } = parsed.data;
	const attributes: Partial<ListAttributes> = {};

	if (requireTitle || title !== undefined) {
		if (typeof title !== 'string' || title.trim() === '') {
			throw new UnprocessableError("Validation failed: Title can't be blank");
		}
		if ([...title].length > MAX_LIST_TITLE_LENGTH) {
			throw new UnprocessableError(
				`Validation failed: Title is too long (maximum is ${MAX_LIST_TITLE_LENGTH} characters)`,
			);
		}
		attributes.title = title;
	}

	if (repliesPolicy !== undefined && repliesPolicy !== null && repliesPolicy !== '') {
		const policy = LIST_REPLIES_POLICIES.find((value) => value === repliesPolicy);
		if (policy === undefined) {
			throw new UnprocessableError(`'${String(repliesPolicy)}' is not a valid replies_policy`);
		}
		attributes.repliesPolicy = policy;
	}

	const exclusiveValue = toBoolean(exclusive);
	if (exclusiveValue !== undefined) {
		attributes.exclusive = exclusiveValue;
	}
	return attributes;
};

// `account_ids[]` はフォームでも JSON でも、DELETE ではクエリでも来る。
const getAccountIds = (req: express.Request): string[] => {
	const sources = [req.body, req.query] as (Record<string, unknown> | undefined)[];
	for (const source of sources) {
		const value = source?.account_ids ?? source?.['account_ids[]'];
		if (value !== undefined) {
			return [value].flat().filter((id): id is string => typeof id === 'string');
		}
	}
	return [];
};

const loadOwnList = async (actorId: string, listId: unknown) => {
	const list = typeof listId === 'string' ? await getList(actorId, listId) : undefined;
	if (list === undefined) {
		throw new NotFoundError();
	}
	return list;
};

router.get('/v1/lists', authRequired, scopeRequired('read:lists'), async (req, res) => {
	const lists = await getLists(getAuthActorId(res));
	res.json(lists.map(listToEntity));
});

router.post('/v1/lists', authRequired, scopeRequired('write:lists'), async (req, res) => {
	const attributes = parseListAttributes(req.body, true);
	const list = await createList(getAuthActorId(res), {
		title: attributes.title!,
		repliesPolicy: attributes.repliesPolicy ?? DEFAULT_LIST_REPLIES_POLICY,
		exclusive: attributes.exclusive ?? false,
	});
	if (list === undefined) {
		throw new UnprocessableError('Validation failed: You have reached the maximum number of lists');
	}
	res.json(listToEntity(list));
});

router.get('/v1/lists/:id', authRequired, scopeRequired('read:lists'), async (req, res) => {
	res.json(listToEntity(await loadOwnList(getAuthActorId(res), req.params.id)));
});

router.put('/v1/lists/:id', authRequired, scopeRequired('write:lists'), async (req, res) => {
	const actorId = getAuthActorId(res);
	const { id } = await loadOwnList(actorId, req.params.id);
	const list = await updateList(actorId, id, parseListAttributes(req.body, false));
	if (list === undefined) {
		throw new NotFoundError();
	}
	res.json(listToEntity(list));
});

router.delete('/v1/lists/:id', authRequired, scopeRequired('write:lists'), async (req, res) => {
	const actorId = getAuthActorId(res);
	const { id } = await loadOwnList(actorId, req.params.id);
	if (!(await deleteList(actorId, id))) {
		throw new NotFoundError();
	}
	res.json({});
});

const accountIdPattern = /^\d+$/;
const toCursor = (value: unknown) =>
	typeof value === 'string' && accountIdPattern.test(value) ? value : undefined;

router.get(
	'/v1/lists/:id/accounts',
	authRequired,
	scopeRequired('read:lists'),
	async (req, res) => {
		const list = await loadOwnList(getAuthActorId(res), req.params.id);
		// Mastodon と同じく `limit=0` なら全件を返し、ページングしない。
		const unlimited = req.query.limit === '0';
		const { limit } = parsePageParams(req.query, LIST_ACCOUNTS_PAGE_LIMITS);
		const { accounts, cursorIds } = await getListAccountsPage(
			list,
			unlimited
				? {}
				: { limit, maxId: toCursor(req.query.max_id), sinceId: toCursor(req.query.since_id) },
		);

		const newest = cursorIds[0];
		const oldest = cursorIds.at(-1);
		if (!unlimited && newest !== undefined && oldest !== undefined) {
			const build = (key: 'max_id' | 'since_id', id: string) => {
				const url = new URL(`https://${mastodonDomain}${req.baseUrl}${req.path}`);
				url.searchParams.set('limit', String(limit));
				url.searchParams.set(key, id);
				return url.toString();
			};
			const links = [`<${build('since_id', newest)}>; rel="prev"`];
			if (accounts.length >= limit) {
				links.unshift(`<${build('max_id', oldest)}>; rel="next"`);
			}
			res.set('Link', links.join(', '));
		}
		res.json(accounts);
	},
);

router.post(
	'/v1/lists/:id/accounts',
	authRequired,
	scopeRequired('write:lists'),
	async (req, res) => {
		const viewer = await loadViewer(res);
		const actorId = getAuthActorId(res);
		const { id } = await loadOwnList(actorId, req.params.id);
		// Mastodon と同じく、存在しないアカウントが1つでもあれば 404。
		const resolved = await Promise.all(getAccountIds(req).map(loadAccount));
		const result = await addListAccounts(
			viewer,
			id,
			resolved.map(({ actor }) => actor.id!),
		);
		if (!result.ok) {
			switch (result.error) {
				case 'not_found':
					throw new NotFoundError();
				case 'not_following':
					throw new UnprocessableError('Validation failed: Account must be a followed account');
				case 'already_member':
					throw new UnprocessableError('Validation failed: Account has already been taken');
			}
		}
		res.json({});
	},
);

router.delete(
	'/v1/lists/:id/accounts',
	authRequired,
	scopeRequired('write:lists'),
	async (req, res) => {
		const actorId = getAuthActorId(res);
		const { id } = await loadOwnList(actorId, req.params.id);
		const iris = await Promise.all(getAccountIds(req).map(resolveActorIriByAccountId));
		await removeListAccounts(
			actorId,
			id,
			iris.filter((iri): iri is string => iri !== undefined),
		);
		res.json({});
	},
);

router.get(
	'/v1/accounts/:id/lists',
	authRequired,
	scopeRequired('read:lists'),
	async (req, res) => {
		const { actor } = await loadAccount(req.params.id);
		const lists = await getListsContaining(getAuthActorId(res), actor.id!);
		res.json(lists.map(listToEntity));
	},
);

router.get(
	'/v1/timelines/list/:list_id',
	authRequired,
	scopeRequired('read:lists'),
	async (req, res) => {
		const viewer = await loadViewer(res);
		const list = await loadOwnList(getAuthActorId(res), req.params.list_id);
		respondWithStatuses(
			req,
			res,
			await getListTimeline(viewer, list, parsePageParams(req.query, STATUS_PAGE_LIMITS)),
		);
	},
);

export default router;
