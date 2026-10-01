import assert from 'node:assert';
import type { APNote } from 'activitypub-types';
import firebase from 'firebase-admin';
import { chunk } from 'lodash-es';
import type { mastodon } from 'masto';
import { apex } from '../activitypub.js';
import { domain, escapeFirestoreKey, toFirestoreKey, unescapeFirestoreKey } from '../firebase.js';
import { getMastodonIds } from '../mastodonId.js';
import type { ObjectMeta } from '../meta.js';
import { UserInfos } from '../schema.js';
import { FIRESTORE_IN_QUERY_LIMIT } from '../store.js';
import type { CamelToSnake } from '../utils.js';
import {
	firstOf,
	isAPNote,
	objectToTypeArray,
	toArray,
	toIdArray,
	toStringValue,
} from '../utils.js';

const PUBLIC_ADDRESSES = new Set([
	'as:Public',
	'Public',
	'https://www.w3.org/ns/activitystreams#Public',
]);

export const isPublicAddress = (address: string): boolean => PUBLIC_ADDRESSES.has(address);

export type StatusVisibility = 'public' | 'unlisted' | 'private' | 'direct';

export const getStatusVisibility = (note: APNote, followersUrl?: string): StatusVisibility => {
	const to = toIdArray(note.to);
	const cc = toIdArray(note.cc);

	if (to.some(isPublicAddress)) {
		return 'public';
	}
	if (cc.some(isPublicAddress)) {
		return 'unlisted';
	}

	const isFollowers = (iri: string) =>
		(followersUrl !== undefined && iri === followersUrl) || iri.endsWith('/followers');

	if (to.some(isFollowers) || cc.some(isFollowers)) {
		return 'private';
	}

	return 'direct';
};

export interface NoteStatusContext {
	repliesMap?: Map<string, { statusId: string; accountId: string }>;
	accountMap?: Map<string, string>;
	followersUrl?: string;
}

const isLocalNote = (note: APNote): boolean => {
	if (typeof note.id !== 'string') {
		return false;
	}
	try {
		return new URL(note.id).host === domain;
	} catch {
		return false;
	}
};

const extractUrl = (
	urlField: unknown,
	account: CamelToSnake<mastodon.v1.Account>,
	id: string,
): string => {
	const first = firstOf(urlField);
	if (typeof first === 'string' && first.length > 0) {
		return first;
	}
	if (typeof first === 'object' && first !== null) {
		if ('href' in first && typeof (first as { href?: unknown }).href === 'string') {
			return (first as { href: string }).href;
		}
	}
	return `https://${domain}/@${account.username}@${domain}/${id}`;
};

const extractSpoilerText = (note: APNote): string => {
	const summary = toStringValue(note.summary);
	if (summary !== undefined) {
		return summary;
	}
	if (typeof note.summaryMap === 'object' && note.summaryMap !== null) {
		const values = Object.values(note.summaryMap);
		const firstVal = firstOf(values);
		if (typeof firstVal === 'string') {
			return firstVal;
		}
	}
	return '';
};

const extractLanguage = (note: APNote, isLocal: boolean): string | null => {
	if (typeof note.contentMap === 'object' && note.contentMap !== null) {
		const keys = Object.keys(note.contentMap);
		if (keys.length > 0 && keys[0] !== undefined) {
			return keys[0];
		}
	}
	if (typeof note.summaryMap === 'object' && note.summaryMap !== null) {
		const keys = Object.keys(note.summaryMap);
		if (keys.length > 0 && keys[0] !== undefined) {
			return keys[0];
		}
	}
	return isLocal ? 'ja' : null;
};

const extractEditedAt = (note: APNote): string | null => {
	if (note.updated === undefined || note.updated === null) {
		return null;
	}
	try {
		const date = new Date(note.updated as string | number | Date);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	} catch {
		return null;
	}
};

const getTotalItems = (collection: unknown): number | undefined => {
	const item = firstOf(collection);
	if (typeof item === 'object' && item !== null && 'totalItems' in item) {
		const total = (item as { totalItems?: unknown }).totalItems;
		if (typeof total === 'number' && Number.isFinite(total)) {
			return total;
		}
	}
	return undefined;
};

const extractTags = (note: APNote): CamelToSnake<mastodon.v1.Tag>[] => {
	const rawTags = toArray(note.tag);
	const tags: CamelToSnake<mastodon.v1.Tag>[] = [];
	const seenNames = new Set<string>();

	for (const tag of rawTags) {
		if (typeof tag !== 'object' || tag === null) {
			continue;
		}
		const types = objectToTypeArray(tag);
		if (types.includes('Hashtag') || (tag as { type?: unknown }).type === 'Hashtag') {
			let name = toStringValue((tag as { name?: unknown }).name) ?? '';
			if (name.startsWith('#')) {
				name = name.slice(1);
			}
			if (name.length === 0 || seenNames.has(name.toLowerCase())) {
				continue;
			}
			seenNames.add(name.toLowerCase());
			const url =
				toStringValue((tag as { href?: unknown }).href) ?? `https://${domain}/tags/${name}`;
			tags.push({
				name,
				url,
			});
		}
	}
	return tags;
};

const extractMentions = (
	note: APNote,
	accountMap?: Map<string, string>,
): CamelToSnake<mastodon.v1.StatusMention>[] => {
	const rawTags = toArray(note.tag);
	const mentions: CamelToSnake<mastodon.v1.StatusMention>[] = [];
	const seenHrefs = new Set<string>();

	for (const tag of rawTags) {
		if (typeof tag !== 'object' || tag === null) {
			continue;
		}
		const types = objectToTypeArray(tag);
		if (types.includes('Mention') || (tag as { type?: unknown }).type === 'Mention') {
			const href = toStringValue((tag as { href?: unknown }).href);
			if (href === undefined || seenHrefs.has(href)) {
				continue;
			}
			seenHrefs.add(href);

			const rawName = toStringValue((tag as { name?: unknown }).name) ?? '';
			const stripped = rawName.startsWith('@') ? rawName.slice(1) : rawName;

			let username = '';
			let acct = '';

			if (stripped.includes('@')) {
				const [u] = stripped.split('@');
				username = u ?? '';
				acct = stripped;
			} else if (stripped.length > 0) {
				username = stripped;
				try {
					const host = new URL(href).host;
					acct = host === domain ? stripped : `${stripped}@${host}`;
				} catch {
					acct = stripped;
				}
			} else {
				try {
					const urlObj = new URL(href);
					const pathParts = urlObj.pathname.split('/').filter(Boolean);
					username = pathParts[pathParts.length - 1] ?? '';
					acct = urlObj.host === domain ? username : `${username}@${urlObj.host}`;
				} catch {
					username = '';
					acct = '';
				}
			}

			const id = accountMap?.get(href) ?? '1';

			mentions.push({
				id,
				username,
				url: href,
				acct,
			});
		}
	}
	return mentions;
};

export interface NoteStatusOptions extends NoteStatusContext {
	id: string;
}

export type MastodonStatus = Omit<CamelToSnake<mastodon.v1.Status>, 'application'> & {
	application: CamelToSnake<mastodon.v1.Application> | null;
};

// `id` には AP IRI ではなく、時系列順に採番した Mastodon ID を渡す (→ ADR-0006、ADR-0058)。
// 取得は `getMastodonIds` で行う。
export const noteObjectToStatus = (
	note: APNote,
	account: CamelToSnake<mastodon.v1.Account>,
	options: string | NoteStatusOptions,
): MastodonStatus => {
	assert(note.id !== undefined, 'note.id is undefined');
	assert(note.published !== undefined, 'note.published is undefined');

	const id = typeof options === 'string' ? options : options.id;
	const context = typeof options === 'string' ? undefined : options;

	const isLocal = isLocalNote(note);
	const inReplyToIri = toIdArray(note.inReplyTo)[0];
	let inReplyToId: string | null = null;
	let inReplyToAccountId: string | null = null;

	if (inReplyToIri !== undefined && context?.repliesMap !== undefined) {
		const replyInfo = context.repliesMap.get(inReplyToIri);
		if (replyInfo !== undefined) {
			inReplyToId = replyInfo.statusId;
			inReplyToAccountId = replyInfo.accountId;
		}
	}

	const meta = (note as { _meta?: ObjectMeta })._meta;
	const favouritesCount = meta?.likesCount ?? getTotalItems(note.likes) ?? 0;
	const reblogsCount = meta?.sharesCount ?? getTotalItems(note.shares) ?? 0;
	const repliesCount = getTotalItems(note.replies) ?? 0;

	return {
		id,
		created_at: note.published.toString(),
		edited_at: extractEditedAt(note),
		in_reply_to_id: inReplyToId,
		in_reply_to_account_id: inReplyToAccountId,
		sensitive: Boolean((note as { sensitive?: unknown }).sensitive),
		spoiler_text: extractSpoilerText(note),
		visibility: getStatusVisibility(note, context?.followersUrl),
		language: extractLanguage(note, isLocal),
		// Mastodon の `uri` は連合で使う ActivityPub の IRI。
		uri: note.id,
		url: extractUrl(note.url, account, id),
		replies_count: repliesCount,
		reblogs_count: reblogsCount,
		favourites_count: favouritesCount,
		reblogged: false,
		favourited: false,
		muted: false,
		bookmarked: false,
		pinned: false,
		content: toStringValue(note.content) ?? '',
		reblog: null,
		application: isLocal
			? {
					name: 'activitypub-firebase',
					website: `https://${domain}`,
				}
			: null,
		account,
		// Media attachments are planned for Phase 4 (Media). Keep as empty array for now.
		media_attachments: [],
		mentions: extractMentions(note, context?.accountMap),
		tags: extractTags(note),
		emojis: [],
		card: null,
		poll: null,
	};
};

export const getAttributedTo = (object: { attributedTo?: unknown }): string | undefined =>
	toIdArray(object.attributedTo)[0];

export const resolveNotesRelations = async (notes: APNote[]): Promise<NoteStatusContext> => {
	const parentIris = Array.from(new Set(notes.flatMap((n) => toIdArray(n.inReplyTo))));
	const mentionActorIris = Array.from(
		new Set(
			notes.flatMap((n) =>
				toArray(n.tag).flatMap((t) => {
					if (typeof t !== 'object' || t === null) {
						return [];
					}
					const types = objectToTypeArray(t);
					if (types.includes('Mention') || (t as { type?: unknown }).type === 'Mention') {
						const href = toStringValue((t as { href?: unknown }).href);
						return href === undefined ? [] : [href];
					}
					return [];
				}),
			),
		),
	);

	// 親 Note を DB から取得
	const parentNotes =
		parentIris.length > 0 ? (await apex.store.getObjects(parentIris)).filter(isAPNote) : [];
	const parentNotesMap = new Map(parentNotes.map((n) => [n.id, n]));

	// 親 Note の Mastodon ID を取得
	const parentMastodonIds =
		parentNotes.length > 0
			? await getMastodonIds(parentNotes.map((n) => ({ iri: n.id, published: n.published })))
			: new Map<string, string>();

	// 親 Note の投稿者 actor ID を収集
	const parentAuthors = parentNotes
		.map((n) => getAttributedTo(n))
		.filter((a): a is string => a !== undefined);

	// 必要なすべての actor ID
	const allActorIds = Array.from(new Set([...mentionActorIris, ...parentAuthors]));

	// UserInfos から一括取得
	const accountMap = new Map<string, string>();
	if (allActorIds.length > 0) {
		const userInfoChunks = await Promise.all(
			chunk(allActorIds.map(escapeFirestoreKey), FIRESTORE_IN_QUERY_LIMIT).map((idChunk) =>
				UserInfos.where(firebase.firestore.FieldPath.documentId(), 'in', idChunk).get(),
			),
		);
		for (const snapshot of userInfoChunks) {
			for (const doc of snapshot.docs) {
				const actorId = unescapeFirestoreKey(toFirestoreKey(doc.id));
				const data = doc.data();
				if (data.id) {
					accountMap.set(actorId, data.id);
				}
			}
		}
	}

	const repliesMap = new Map<string, { statusId: string; accountId: string }>();
	for (const parentIri of parentIris) {
		const parentNote = parentNotesMap.get(parentIri);
		if (!parentNote) {
			continue;
		}
		const statusId = parentMastodonIds.get(parentNote.id);
		if (!statusId) {
			continue;
		}
		const authorId = getAttributedTo(parentNote);
		const accountId = authorId ? (accountMap.get(authorId) ?? '1') : '1';
		repliesMap.set(parentIri, { statusId, accountId });
	}

	return {
		repliesMap,
		accountMap,
	};
};
