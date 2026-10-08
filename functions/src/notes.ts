import type { APObject } from './apex/index.js';
import { apex } from './apex.js';
import type { NoteTag } from './mastodon/statusContent.js';
import { toIdArray } from './utils.js';

// ローカル actor の Note を組み立てて保存し、Create を outbox に積んで配送する (→ ADR-0063)。
// `/activitypub/createPost` と `POST /api/v1/statuses` が共有する。

export type NoteVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export interface NoteAttachment {
	type: string;
	mediaType?: string | undefined;
	url: string;
	name?: string | null | undefined;
	blurhash?: string | undefined;
	width?: number | undefined;
	height?: number | undefined;
	focalPoint?: [number, number] | undefined;
	icon?:
		| {
				type: string;
				url: string;
		  }
		| undefined;
	[key: string]: unknown;
}

export interface NewNote {
	// 先に採番しておきたい場合 (Idempotency-Key の予約) に指定する。省略時はここで採番する。
	id?: string;
	// HTML。プレーンテキストは `plainTextToHtml` で変換してから渡す。
	content: string;
	visibility: NoteVisibility;
	// リプライ先の IRI。
	inReplyTo?: string | undefined;
	// 宛先に加える actor の IRI (メンション相手など)。
	mentions?: string[];
	tag?: NoteTag[] | undefined;
	summary?: string | undefined;
	sensitive?: boolean;
	language?: string | undefined;
	attachment?: NoteAttachment[] | undefined;
}

// Mastodon の `ActivityPub::TagManager#to` / `#cc` と同じ割り当て。
export const addressNote = (
	visibility: NoteVisibility,
	followersIri: string,
	mentions: string[],
) => {
	const { publicAddress } = apex.consts;
	switch (visibility) {
		case 'public': {
			return { to: [publicAddress], cc: [followersIri, ...mentions] };
		}
		case 'unlisted': {
			return { to: [followersIri], cc: [publicAddress, ...mentions] };
		}
		case 'private': {
			return { to: [followersIri], cc: mentions };
		}
		case 'direct': {
			return { to: mentions, cc: [] };
		}
	}
};

const escapeHtml = (text: string) =>
	text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

// プレーンテキストを Mastodon と同じ形の HTML にする。空行で段落を分け、改行は `<br />` にする。
// リンク・メンション・ハッシュタグの自動リンクは行わない (→ ADR-0063)。
export const plainTextToHtml = (text: string) => {
	const trimmed = text.replaceAll('\r\n', '\n').trim();
	if (trimmed === '') {
		return '';
	}
	return trimmed
		.split(/\n(?:[^\S\r\n]*\n)+/)
		.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`)
		.join('');
};

export const publishNote = async (actor: APObject, note: NewNote) => {
	const followersIri = toIdArray(actor.followers)[0];
	if (followersIri === undefined) {
		throw new Error(`actor has no followers collection: ${actor.id}`);
	}
	const mentions = (note.mentions ?? []).filter((iri) => iri !== actor.id);
	const { to, cc } = addressNote(note.visibility, followersIri, mentions);

	const id = note.id ?? apex.utils.objectIdToIRI();
	const published = new Date().toISOString();
	const inReplyTo = note.inReplyTo === undefined ? undefined : toIdArray(note.inReplyTo);
	const object: APObject = {
		id,
		url: id,
		published,
		type: 'Note',
		attributedTo: actor.id,
		to,
		cc,
		content: note.content,
		...(note.tag === undefined || note.tag.length === 0 ? {} : { tag: note.tag }),
		...(note.language === undefined ? {} : { contentMap: { [note.language]: note.content } }),
		...(note.summary === undefined ? {} : { summary: note.summary }),
		...(note.sensitive === undefined ? {} : { sensitive: note.sensitive }),
		...(inReplyTo === undefined || inReplyTo.length === 0 ? {} : { inReplyTo }),
		...(note.attachment === undefined || note.attachment.length === 0
			? {}
			: { attachment: note.attachment }),
	};

	await apex.store.saveObject(object);
	const activity = await apex.buildActivity('Create', actor.id, to, { cc, object, published });
	await apex.addToOutbox(actor, activity);

	return { object, activity };
};

const unescapeHtml = (html: string) =>
	html
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&amp;', '&');

// HTML からプレーンテキストを復元する (DELETE 応答の `text` 属性用 → ADR-0064)。
export const htmlToPlainText = (html: string) =>
	unescapeHtml(
		html
			.replaceAll(/\r\n/g, '\n')
			.replaceAll(/<br\s*\/?>/gi, '\n')
			.replaceAll(/<\/p>\s*<p[^>]*>/gi, '\n\n')
			.replaceAll(/<[^>]+>/g, ''),
	).trim();

// Note を Tombstone 化して保存し、Delete アクティビティを outbox に積んで配送する (→ ADR-0064)。
export const deleteNote = async (actor: APObject, note: APObject) => {
	const tombstone = await apex.buildTombstone(note);
	await apex.store.updateObject(tombstone, actor.id, true);

	const followersIri = toIdArray(actor.followers)[0];
	const noteTo = toIdArray(note.to);
	const noteCc = toIdArray(note.cc);
	const to = noteTo.length > 0 ? noteTo : [apex.consts.publicAddress];
	let cc = noteCc;
	if (cc.length === 0 && followersIri !== undefined) {
		cc = [followersIri];
	}

	const activity = await apex.buildActivity('Delete', actor.id, to, {
		cc,
		object: tombstone,
	});
	await apex.addToOutbox(actor, activity);

	return { tombstone, activity };
};
