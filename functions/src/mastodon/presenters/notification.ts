import type { APActor } from 'activitypub-types';
import { uniq, zip } from 'lodash-es';
import type { mastodon } from 'masto';
import { getFollowing } from '../../social/follows.js';
import type { NoteObject } from '../../social/types.js';
import { isNoteVisibleTo } from '../../social/visibility.js';
import { getObjects } from '../../store/objects.js';
import type { NotificationRecord, NotificationType } from '../../schema.js';
import type { CamelToSnake } from '../../utils.js';
import { getAttributedTo, isAPActor, isAPNote } from '../../utils.js';
import { resolveAccountIds, userIdsToAccountsMap } from './account.js';
import type { StatusEntity } from './status.js';
import { notesToStatuses } from './status.js';

export interface NotificationEntity {
	id: string;
	type: NotificationType;
	created_at: string;
	account: CamelToSnake<mastodon.v1.Account>;
	status?: StatusEntity | undefined;
	group_key: string;
}

// NotificationRecord 群から NotificationEntity 群をまとめて組み立てる (→ ADR-0089)。
// actor が存在しない場合や Note が Tombstone / 閲覧不可の通知は安全に除外する。
export const recordsToNotifications = async (
	records: NotificationRecord[],
	viewer?: APActor | undefined,
): Promise<NotificationEntity[]> => {
	if (records.length === 0) {
		return [];
	}

	const accountIris = uniq(records.map((r) => r.accountIri));
	const statusIris = uniq(
		records.map((r) => r.statusIri).filter((iri): iri is string => iri !== null),
	);

	const [actorObjects, noteObjects] = await Promise.all([
		getObjects(accountIris),
		getObjects(statusIris),
	]);

	// 1. APActor であるもののみ有効とする
	const validActors = actorObjects.filter(isAPActor);
	const validActorIris = validActors.map((a) => a.id);
	const validAccountIds = await resolveAccountIds(validActorIris);
	const accountsMap = await userIdsToAccountsMap(validActorIris, validAccountIds);

	// 2. Note かつ Tombstone ではなく attributedTo があるもの
	const rawNotes = noteObjects.filter(
		(obj): obj is NoteObject =>
			isAPNote(obj) &&
			(obj as { type: string }).type !== 'Tombstone' &&
			getAttributedTo(obj) !== undefined,
	);

	// 可視性チェック
	const viewerFollowing = new Set(viewer ? await getFollowing(viewer) : []);
	const visibleNotes = rawNotes.filter((note) =>
		isNoteVisibleTo(note, viewer?.id, viewerFollowing),
	);

	// 投稿者 actor が存在するか確認 (notesToStatuses 内の userIdsToAccounts で落ちないようにガード)
	const noteAuthorIris = uniq(
		visibleNotes
			.map((note) => getAttributedTo(note))
			.filter((iri): iri is string => iri !== undefined),
	);
	const noteAuthors = (await getObjects(noteAuthorIris)).filter(isAPActor);
	const noteAuthorSet = new Set(noteAuthors.map((a) => a.id));
	const safeNotes = visibleNotes.filter((note) => {
		const author = getAttributedTo(note);
		return author !== undefined && noteAuthorSet.has(author);
	});

	const statuses = await notesToStatuses(safeNotes, viewer);
	const statusesMap = new Map(
		zip(
			safeNotes.map((n) => n.id),
			statuses,
		),
	);

	// 3. 各レコードをエンティティに変換 (組み立て不能なものはスキップ)
	const result: NotificationEntity[] = [];
	for (const record of records) {
		const account = accountsMap.get(record.accountIri);
		if (account === undefined) {
			continue;
		}

		if (record.type === 'follow') {
			result.push({
				id: record.id,
				type: record.type,
				created_at: record.createdAt.toDate().toISOString(),
				account,
				group_key: `ungrouped-${record.id}`,
			});
			continue;
		}

		if (record.statusIri === null) {
			continue;
		}
		const status = statusesMap.get(record.statusIri);
		if (status === undefined) {
			continue;
		}

		result.push({
			id: record.id,
			type: record.type,
			created_at: record.createdAt.toDate().toISOString(),
			account,
			status,
			group_key: `ungrouped-${record.id}`,
		});
	}

	return result;
};

export const recordToNotification = async (
	record: NotificationRecord,
	viewer?: APActor | undefined,
): Promise<NotificationEntity | undefined> => {
	const notifications = await recordsToNotifications([record], viewer);
	return notifications[0];
};
