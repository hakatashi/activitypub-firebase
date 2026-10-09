import express from 'express';
import { z } from 'zod';
import { normalizeHashtag, toHashtagDisplayName } from '../../hashtags.js';
import { getOptionalViewer } from '../http/auth.js';
import { toBoolean } from '../http/params.js';
import { respondWithStatuses } from '../http/responses.js';
import { getValidParams, getValidQuery, validate } from '../http/validation.js';
import { parsePageParams } from '../pagination.js';
import { STATUS_PAGE_LIMITS, getHashtagTimeline } from '../presenters/status.js';
import { toTagEntity } from '../presenters/tag.js';

// ハッシュタグのタイムラインと Tag エンティティ (→ ADR-0103)。
const router = express.Router();

const booleanParam = z
	.union([z.boolean(), z.string()])
	.optional()
	.transform((value) => toBoolean(value) === true);

// `any[]=a&any[]=b` も `any=a` も受け付け、正規化できないタグ名は捨てる。
const hashtagListParam = z
	.union([z.string(), z.array(z.string())])
	.optional()
	.catch(undefined)
	.transform((value) =>
		(value === undefined ? [] : [value].flat()).flatMap((name) => normalizeHashtag(name) ?? []),
	);

const hashtagParamsSchema = z.object({ hashtag: z.string() });

const hashtagTimelineQuerySchema = z.object({
	local: booleanParam,
	remote: booleanParam,
	only_media: booleanParam,
	any: hashtagListParam,
	all: hashtagListParam,
	none: hashtagListParam,
});

router.get(
	'/v1/timelines/tag/:hashtag',
	validate({ params: hashtagParamsSchema, query: hashtagTimelineQuerySchema }),
	async (req, res) => {
		const { hashtag } = getValidParams(res, hashtagParamsSchema);
		const query = getValidQuery(res, hashtagTimelineQuerySchema);
		const viewer = await getOptionalViewer(req, res);
		const normalized = normalizeHashtag(hashtag);
		// Mastodon も手元に無いタグには空配列を返す。
		if (normalized === undefined) {
			respondWithStatuses(req, res, []);
			return;
		}
		respondWithStatuses(
			req,
			res,
			await getHashtagTimeline(
				{
					hashtag: normalized,
					any: query.any,
					all: query.all,
					none: query.none,
					local: query.local,
					remote: query.remote,
					onlyMedia: query.only_media,
				},
				parsePageParams(req.query, STATUS_PAGE_LIMITS),
				viewer,
			),
		);
	},
);

const tagParamsSchema = z.object({ name: z.string() });

// 手元にそのタグの Note が無くても 200 で返す (Mastodon も未知のタグには Tag.new を返す)。
router.get('/v1/tags/:name', validate({ params: tagParamsSchema }), (req, res) => {
	const { name } = getValidParams(res, tagParamsSchema);
	const displayName = toHashtagDisplayName(name);
	if (displayName === undefined) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}
	res.json(toTagEntity(displayName));
});

export default router;
