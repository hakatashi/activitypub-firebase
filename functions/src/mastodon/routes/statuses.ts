import assert from 'node:assert';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import { apex } from '../../apex.js';
import { getFollowing } from '../../social/follows.js';
import type { NoteObject } from '../../social/types.js';
import { mastodonDomain } from '../../firebase.js';
import { reserveIdempotencyKey } from '../../idempotency.js';
import { getIriByMastodonId } from '../../mastodonId.js';
import { deleteNote, htmlToPlainText, publishNote } from '../../notes.js';
import * as webfinger from '../../webfinger.js';
import { getAttributedTo, isAPNote, toError } from '../../utils.js';
import { createAsyncRouter } from '../http/asyncRouter.js';
import { authRequired, getOptionalViewer, scopeRequired } from '../http/auth.js';
import { isPresent, toBoolean } from '../http/params.js';
import { unprocessable } from '../http/responses.js';
import { instanceV2 } from '../instanceInformation.js';
import { assertIsAPActor } from '../presenters/account.js';
import {
	getStatusAncestors,
	getStatusByIri,
	getStatusDescendants,
	notesToStatuses,
} from '../presenters/status.js';
import type { StatusEntity } from '../presenters/status.js';
import { extractMentions, formatPostContent } from '../statusContent.js';
import { isNoteVisibleTo } from '../statusAttributes.js';

const router = createAsyncRouter();

// JSON でもフォームでも届く。Elk は未指定の項目を `null` や空配列で送ってくる。
export const createStatusBodySchema = z.object({
	status: z.string().nullish(),
	in_reply_to_id: z.string().nullish(),
	sensitive: z.union([z.boolean(), z.string()]).nullish(),
	spoiler_text: z.string().nullish(),
	visibility: z.enum(['public', 'unlisted', 'private', 'direct']).nullish(),
	language: z.string().nullish(),
	// Phase 4 まで未対応。空でない値が来たら 422 にする (→ ADR-0063)。
	media_ids: z.unknown().optional(),
	poll: z.unknown().optional(),
	scheduled_at: z.unknown().optional(),
});

router.post('/v1/statuses', authRequired, scopeRequired('write:statuses'), async (req, res) => {
	const parsedBody = createStatusBodySchema.safeParse(req.body ?? {});
	if (!parsedBody.success) {
		unprocessable(res, `Validation failed: ${parsedBody.error.issues[0]?.message ?? 'invalid'}`);
		return;
	}
	const body = parsedBody.data;

	for (const field of ['media_ids', 'poll', 'scheduled_at'] as const) {
		if (isPresent(body[field])) {
			unprocessable(res, `${field} is not supported yet`);
			return;
		}
	}

	const spoilerText = body.spoiler_text?.trim() ?? '';
	// 本文が空で注意書きがあれば、注意書きを本文に回す (Mastodon と同じ)。
	const text = body.status?.trim() || spoilerText;
	if (text === '') {
		unprocessable(res, "Validation failed: Text can't be blank");
		return;
	}
	const maxCharacters = instanceV2.configuration.statuses.max_characters;
	if ([...text].length + [...spoilerText].length > maxCharacters) {
		unprocessable(res, `Validation failed: Text character limit of ${maxCharacters} exceeded`);
		return;
	}

	const actor = await apex.store.getObject(res.locals.actorId as string, true);
	assertIsAPActor(actor);

	let replyTarget: NoteObject | undefined;
	if (isPresent(body.in_reply_to_id)) {
		const iri = await getIriByMastodonId(body.in_reply_to_id ?? '');
		const target = iri === undefined ? undefined : await apex.store.getObject(iri);
		const visible =
			isAPNote(target) && isNoteVisibleTo(target, actor.id, new Set(await getFollowing(actor)));
		if (!visible) {
			res
				.status(404)
				.json({ error: 'The post you are trying to reply to does not appear to exist.' });
			return;
		}
		replyTarget = target;
	}

	const noteIri = apex.utils.objectIdToIRI();
	const idempotencyKey = req.get('Idempotency-Key');
	let release: (() => Promise<void>) | undefined;
	if (idempotencyKey !== undefined && idempotencyKey !== '') {
		const reservation = await reserveIdempotencyKey({
			actorId: actor.id,
			key: idempotencyKey,
			noteIri,
		});
		if (reservation.type === 'duplicate') {
			const status = await getStatusByIri(reservation.noteIri);
			if (status === undefined) {
				// 先行リクエストがまだ Note を保存していない (Mastodon のロック取得失敗と同じ扱い)。
				res.status(503).json({ error: 'Duplicate request is in progress, try again later' });
				return;
			}
			res.json(status);
			return;
		}
		({ release } = reservation);
	}

	try {
		const extractedMentions = extractMentions(text);
		const resolvedMentions = await webfinger.resolveMentions(extractedMentions);
		const formatted = formatPostContent(text, {
			resolvedMentions,
			mastodonDomain,
		});

		await publishNote(actor, {
			id: noteIri,
			content: formatted.html,
			visibility: body.visibility ?? 'public',
			inReplyTo: replyTarget?.id,
			mentions: formatted.mentionedActorIris,
			tag: formatted.tags,
			summary: spoilerText === '' ? undefined : spoilerText,
			sensitive: spoilerText !== '' || (toBoolean(body.sensitive) ?? false),
			language: body.language ?? undefined,
		});
	} catch (error) {
		// Note が保存されていなければ、再送で作り直せるよう予約を取り消す。
		// 保存済みで配送だけ失敗した場合は、再送で重複しないよう予約を残す。
		if (release !== undefined && (await apex.store.getObject(noteIri)) === undefined) {
			await release();
		}
		logger.error({ type: 'postStatusError', error: toError(error).message });
		res.status(500).json({ error: 'Failed to create the status' });
		return;
	}

	const status = await getStatusByIri(noteIri);
	assert(status !== undefined, 'created status is undefined');
	res.json(status);
});

export const statusParamsSchema = z.object({
	id: z.string().min(1),
});

router.get('/v1/statuses/:id/context', async (req, res) => {
	const parsedParams = statusParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const iri = await getIriByMastodonId(parsedParams.data.id);
	const note = iri === undefined ? undefined : await apex.store.getObject(iri);
	if (!isAPNote(note)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const viewer = await getOptionalViewer(req, res);
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	if (!isNoteVisibleTo(note, viewer?.id, viewerFollowing)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const [ancestors, descendants] = await Promise.all([
		getStatusAncestors(note, viewer, viewerFollowing),
		getStatusDescendants(note, viewer, viewerFollowing),
	]);

	res.json({ ancestors, descendants });
});

router.get('/v1/statuses/:id', async (req, res) => {
	const parsedParams = statusParamsSchema.safeParse(req.params);
	if (!parsedParams.success) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const iri = await getIriByMastodonId(parsedParams.data.id);
	const note = iri === undefined ? undefined : await apex.store.getObject(iri);
	if (!isAPNote(note)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const viewer = await getOptionalViewer(req, res);
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	if (!isNoteVisibleTo(note, viewer?.id, viewerFollowing)) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	const [status] = await notesToStatuses([note], viewer);
	if (status === undefined) {
		res.status(404).json({ error: 'Record not found' });
		return;
	}

	res.json(status);
});

router.delete(
	'/v1/statuses/:id',
	authRequired,
	scopeRequired('write:statuses'),
	async (req, res) => {
		const parsedParams = statusParamsSchema.safeParse(req.params);
		if (!parsedParams.success) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const iri = await getIriByMastodonId(parsedParams.data.id);
		const note = iri === undefined ? undefined : await apex.store.getObject(iri);
		if (!isAPNote(note)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actor = await apex.store.getObject(res.locals.actorId as string, true);
		assertIsAPActor(actor);

		// 自分の投稿のみ削除可能。他人の投稿なら 404 (存在秘匿 → ADR-0064)。
		if (getAttributedTo(note) !== actor.id) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		// 削除前の Note から Status を生成する (Mastodon 仕様: 削除して再編集するために本文が必要)。
		const [status] = await notesToStatuses([note]);
		assert(status !== undefined, 'status is undefined');
		const statusWithText: StatusEntity = {
			...status,
			text: htmlToPlainText(status.content),
		};

		await deleteNote(actor, note);

		res.json(statusWithText);
	},
);

export default router;
