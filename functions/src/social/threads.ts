import { apex } from '../apex.js';
import type { APActor } from 'activitypub-types';
import { getAttributedTo, isAPNote, toIdArray } from '../utils.js';
import type { NoteObject } from './types.js';
import { isNoteVisibleTo } from './visibility.js';

const MAX_ANCESTORS = 40;
const MAX_DESCENDANTS = 60;
const MAX_DESCENDANTS_DEPTH = 20;

export const getThreadAncestors = async (
	note: NoteObject,
	viewer: APActor | undefined,
	viewerFollowing: Set<string>,
): Promise<NoteObject[]> => {
	const ancestorNotes: NoteObject[] = [];
	const visited = new Set<string>([note.id]);
	let currentReplyTo = toIdArray(note.inReplyTo)[0];

	while (currentReplyTo !== undefined && ancestorNotes.length < MAX_ANCESTORS) {
		if (visited.has(currentReplyTo)) {
			// 循環参照を検出したら停止 (→ ADR-0064)
			break;
		}
		visited.add(currentReplyTo);
		const parent = await apex.store.getObject(currentReplyTo);
		if (!isAPNote(parent)) {
			// 手元に存在しないか Note でなければチェーン終了 (リモートへは取りに行かない → ADR-0059)
			break;
		}
		ancestorNotes.push(parent);
		currentReplyTo = toIdArray(parent.inReplyTo)[0];
	}

	ancestorNotes.reverse();
	return ancestorNotes.filter((ancestor) => isNoteVisibleTo(ancestor, viewer?.id, viewerFollowing));
};

export const getThreadDescendants = async (
	note: NoteObject,
	viewer: APActor | undefined,
	viewerFollowing: Set<string>,
): Promise<NoteObject[]> => {
	const descendantNotes: NoteObject[] = [];
	const visited = new Set<string>([note.id]);

	const collect = async (parentIri: string, depth: number) => {
		if (depth >= MAX_DESCENDANTS_DEPTH || descendantNotes.length >= MAX_DESCENDANTS) {
			return;
		}
		const rawReplies = await apex.store.getReplies(parentIri);
		const replies = rawReplies.filter(isAPNote);

		// Mastodon 仕様: 親と同じ投稿者による返信 (self-reply) を優先して上位に持ってくる
		const parentNote = descendantNotes.find((d) => d.id === parentIri) ?? note;
		const parentAuthor = getAttributedTo(parentNote);
		const sortedReplies =
			parentAuthor === undefined
				? replies
				: [...replies].sort((a, b) => {
						const aIsSelf = getAttributedTo(a) === parentAuthor;
						const bIsSelf = getAttributedTo(b) === parentAuthor;
						if (aIsSelf && !bIsSelf) {
							return -1;
						}
						if (!aIsSelf && bIsSelf) {
							return 1;
						}
						return 0;
					});

		for (const reply of sortedReplies) {
			if (visited.has(reply.id) || descendantNotes.length >= MAX_DESCENDANTS) {
				continue;
			}
			visited.add(reply.id);
			descendantNotes.push(reply);
			await collect(reply.id, depth + 1);
		}
	};

	await collect(note.id, 0);

	return descendantNotes.filter((descendant) =>
		isNoteVisibleTo(descendant, viewer?.id, viewerFollowing),
	);
};
