import express from 'express';
import assert from 'node:assert';
import firebase from 'firebase-admin';
import { logger } from 'firebase-functions/v2';
import { z } from 'zod';
import { apex } from '../../apex.js';
import { getFollowing } from '../../social/follows.js';
import type { NoteObject } from '../../social/types.js';
import { escapeFirestoreKey, mastodonDomain } from '../../firebase.js';
import { reserveIdempotencyKey } from '../../idempotency.js';
import { getIriByMastodonId } from '../../mastodonId.js';
import { deleteNote, htmlToPlainText, publishNote } from '../../notes.js';
import type { NoteAttachment } from '../../notes.js';
import { MediaAttachments } from '../../schema.js';
import type { MediaAttachmentRecord } from '../../schema.js';
import * as webfinger from '../../webfinger.js';
import { getAttributedTo, isAPNote, toError } from '../../utils.js';
import { authRequired, getOptionalViewer, scopeRequired } from '../http/auth.js';
import { NotFoundError, UnprocessableError } from '../http/errors.js';
import { loadStatus, loadViewer, loadVisibleStatus } from '../http/loaders.js';
import { isPresent, toBoolean } from '../http/params.js';
import { getValidBody, validate } from '../http/validation.js';
import { instanceV2 } from '../instanceInformation.js';
import {
	getStatusAncestors,
	getStatusById,
	getStatusByIri,
	getStatusDescendants,
	notesToStatuses,
} from '../presenters/status.js';
import type { StatusEntity } from '../presenters/status.js';
import { extractMentions, formatPostContent } from '../statusContent.js';
import { isNoteVisibleTo } from '../statusAttributes.js';

const router = express.Router();

// JSON でもフォームでも届く。Elk は未指定の項目を `null` や空配列で送ってくる。
export const createStatusBodySchema = z.object({
	status: z.string().nullish(),
	in_reply_to_id: z.string().nullish(),
	sensitive: z.union([z.boolean(), z.string()]).nullish(),
	spoiler_text: z.string().nullish(),
	visibility: z.enum(['public', 'unlisted', 'private', 'direct']).nullish(),
	language: z.string().nullish(),
	media_ids: z.unknown().optional(),
	'media_ids[]': z.unknown().optional(),
	poll: z.unknown().optional(),
	scheduled_at: z.unknown().optional(),
});

router.post(
	'/v1/statuses',
	authRequired,
	scopeRequired('write:statuses'),
	validate({ body: createStatusBodySchema }),
	async (req, res) => {
		const body = getValidBody(res, createStatusBodySchema);

		for (const field of ['poll', 'scheduled_at'] as const) {
			if (isPresent(body[field])) {
				throw new UnprocessableError(`${field} is not supported yet`);
			}
		}

		const rawMediaIds = body.media_ids ?? (body as Record<string, unknown>)['media_ids[]'];
		let mediaIds: string[] = [];
		if (rawMediaIds !== undefined && rawMediaIds !== null) {
			if (Array.isArray(rawMediaIds)) {
				mediaIds = rawMediaIds.map((item) => String(item).trim()).filter((item) => item.length > 0);
			} else if (typeof rawMediaIds === 'string') {
				const trimmed = rawMediaIds.trim();
				if (trimmed.length > 0) {
					mediaIds = [trimmed];
				}
			}
		}

		const maxMediaAttachments = instanceV2.configuration.statuses.max_media_attachments;
		if (mediaIds.length > maxMediaAttachments) {
			throw new UnprocessableError(
				`Validation failed: Cannot attach more than ${maxMediaAttachments} files`,
			);
		}

		if (new Set(mediaIds).size !== mediaIds.length) {
			throw new UnprocessableError(
				'Validation failed: Media not found or already attached to another post',
			);
		}

		const actor = await loadViewer(res);

		const mediaRecords: MediaAttachmentRecord[] = [];
		if (mediaIds.length > 0) {
			const docSnapshots = await Promise.all(
				mediaIds.map((id) => MediaAttachments.doc(escapeFirestoreKey(id)).get()),
			);
			for (const doc of docSnapshots) {
				if (!doc.exists) {
					throw new UnprocessableError(
						'Validation failed: Media not found or already attached to another post',
					);
				}
				const record = doc.data()!;
				if (record.actorId !== actor.id || record.statusIri !== null) {
					throw new UnprocessableError(
						'Validation failed: Media not found or already attached to another post',
					);
				}
				mediaRecords.push(record);
			}
		}

		const spoilerText = body.spoiler_text?.trim() ?? '';
		// 本文が空で注意書きがあれば、注意書きを本文に回す (Mastodon と同じ)。
		const text = body.status?.trim() || spoilerText;
		if (text === '' && mediaRecords.length === 0) {
			throw new UnprocessableError("Validation failed: Text can't be blank");
		}
		const maxCharacters = instanceV2.configuration.statuses.max_characters;
		if ([...text].length + [...spoilerText].length > maxCharacters) {
			throw new UnprocessableError(
				`Validation failed: Text character limit of ${maxCharacters} exceeded`,
			);
		}

		let replyTarget: NoteObject | undefined;
		if (isPresent(body.in_reply_to_id)) {
			const iri = await getIriByMastodonId(body.in_reply_to_id ?? '');
			const target = iri === undefined ? undefined : await apex.store.getObject(iri);
			const visible =
				isAPNote(target) && isNoteVisibleTo(target, actor.id, new Set(await getFollowing(actor)));
			if (!visible) {
				throw new NotFoundError('The post you are trying to reply to does not appear to exist.');
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

			const attachments: NoteAttachment[] = mediaRecords.map((record) => {
				const attachment: NoteAttachment = {
					type: 'Document',
					mediaType: record.mimeType,
					url: record.url,
					name: record.description || null,
					blurhash: record.blurhash,
					...(record.meta.original?.width === undefined
						? {}
						: { width: record.meta.original.width }),
					...(record.meta.original?.height === undefined
						? {}
						: { height: record.meta.original.height }),
					...(record.meta.focus === undefined
						? {}
						: { focalPoint: [record.meta.focus.x, record.meta.focus.y] }),
					icon: {
						type: 'Image',
						url: record.previewUrl,
					},
				};
				return attachment;
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
				attachment: attachments.length > 0 ? attachments : undefined,
			});

			if (mediaRecords.length > 0) {
				const nowTimestamp = firebase.firestore.Timestamp.now();
				await Promise.all(
					mediaRecords.map((record) =>
						MediaAttachments.doc(escapeFirestoreKey(record.id)).update({
							statusIri: noteIri,
							updatedAt: nowTimestamp,
						}),
					),
				);
			}
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
	},
);

router.get('/v1/statuses/:id/context', async (req, res) => {
	const viewer = await getOptionalViewer(req, res);
	const { note, viewerFollowing } = await loadVisibleStatus(req.params.id, viewer, {
		loadFollowing: true,
	});

	const [ancestors, descendants] = await Promise.all([
		getStatusAncestors(note, viewer, viewerFollowing),
		getStatusDescendants(note, viewer, viewerFollowing),
	]);

	res.json({ ancestors, descendants });
});

router.get('/v1/statuses/:id', async (req, res) => {
	const viewer = await getOptionalViewer(req, res);
	const status = await getStatusById(req.params.id, viewer);
	if (status === undefined) {
		throw new NotFoundError();
	}

	res.json(status);
});

router.delete(
	'/v1/statuses/:id',
	authRequired,
	scopeRequired('write:statuses'),
	async (req, res) => {
		const actor = await loadViewer(res);
		const note = await loadStatus(req.params.id);

		// 自分の投稿のみ削除可能。他人の投稿なら 404 (存在秘匿 → ADR-0064)。
		if (getAttributedTo(note) !== actor.id) {
			throw new NotFoundError();
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
