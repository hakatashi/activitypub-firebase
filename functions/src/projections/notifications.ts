import assert from 'node:assert';
import type {
	DocumentReference,
	DocumentSnapshot,
	Transaction,
	Timestamp,
} from '@google-cloud/firestore';
import firebase from 'firebase-admin';
import { isEqual } from 'lodash-es';
import type { APObject } from '../apex/index.js';
import { escapeFirestoreKey } from '../firebase.js';
import { localActorId } from '../localActor.js';
import { getMastodonIds } from '../mastodonId.js';
import { MastodonIdsByIri, Notifications, Objects, Streams } from '../schema.js';
import type { NotificationRecord, NotificationType } from '../schema.js';
import {
	getAttributedTo,
	isAPNote,
	isAPUndo,
	toArray,
	toIdArray,
	toStringValue,
	toTypeArray,
} from '../utils.js';

// 通知の射影 (`userInfos/{ローカル actor}/notifications/{アクティビティ IRI}`) を、
// 受信したアクティビティの書き換え前後から差分で更新する (→ ADR-0088)。
// Store が、アクティビティを書き換えるのと同じトランザクションの中で呼ぶ。
// `social/` や `mastodon/` を import しないこと。

const serverTimestamp = () =>
	firebase.firestore.FieldValue.serverTimestamp() as unknown as Timestamp;

const hasLocalMention = (note: APObject): boolean =>
	toArray(note.tag).some((tag) => {
		if (typeof tag !== 'object' || tag === null || Array.isArray(tag)) {
			return false;
		}
		const tagObj = tag as { type?: unknown; href?: unknown };
		return (
			toTypeArray(tagObj.type).includes('Mention') && toStringValue(tagObj.href) === localActorId
		);
	});

export interface NotificationCandidate {
	type: NotificationType;
	activityIri: string;
	accountIri: string;
	statusIri: string | null;
	published?: unknown;
}

const resolveCandidate = async (
	activity: APObject | undefined,
	getNoteDoc: (ref: DocumentReference<APObject>) => Promise<DocumentSnapshot<APObject> | undefined>,
): Promise<NotificationCandidate | undefined> => {
	if (activity === undefined) {
		return undefined;
	}
	const activityIri = activity.id;
	if (activityIri === undefined) {
		return undefined;
	}
	const sender = toIdArray(activity.actor)[0];
	if (sender === undefined || sender === localActorId) {
		return undefined;
	}

	const types = toTypeArray(activity.type);
	if (types.includes('Follow')) {
		const target = toIdArray(activity.object)[0];
		if (target !== localActorId) {
			return undefined;
		}
		return {
			type: 'follow',
			activityIri,
			accountIri: sender,
			statusIri: null,
			published: activity.published,
		};
	}

	if (types.includes('Create')) {
		const embeddedNote = toArray(activity.object).find((item): item is APObject => isAPNote(item));
		let note = embeddedNote;
		if (note === undefined) {
			const noteIri = toIdArray(activity.object)[0];
			if (noteIri === undefined) {
				return undefined;
			}
			const noteDoc = await getNoteDoc(Objects.doc(escapeFirestoreKey(noteIri)));
			note = noteDoc?.data();
		}
		if (note === undefined) {
			return undefined;
		}
		const noteAuthor = getAttributedTo(note);
		if (noteAuthor === localActorId) {
			return undefined;
		}
		if (!hasLocalMention(note)) {
			return undefined;
		}
		const statusIri = note.id ?? toIdArray(activity.object)[0];
		if (statusIri === undefined) {
			return undefined;
		}
		return {
			type: 'mention',
			activityIri,
			accountIri: sender,
			statusIri,
			published: activity.published,
		};
	}

	if (types.includes('Like') || types.includes('Announce')) {
		const isLike = types.includes('Like');
		const noteIri = toIdArray(activity.object)[0];
		if (noteIri === undefined) {
			return undefined;
		}
		const noteDoc = await getNoteDoc(Objects.doc(escapeFirestoreKey(noteIri)));
		const note = noteDoc?.data();
		if (note === undefined || getAttributedTo(note) !== localActorId) {
			return undefined;
		}
		return {
			type: isLike ? 'favourite' : 'reblog',
			activityIri,
			accountIri: sender,
			statusIri: noteIri,
			published: activity.published,
		};
	}

	return undefined;
};

// トランザクション内で射影の更新を準備する。読み取りだけをここで済ませ、書き込みは戻り値の関数で行う
// (→ ADR-0082, ADR-0084 と同じ形)。
// 射影への寄与がなければ undefined を返す。
export const prepareNotificationProjectionUpdate = async (
	transaction: Transaction,
	before: APObject | undefined,
	after: APObject | undefined,
): Promise<((mastodonId?: string) => void) | undefined> => {
	const isCreation = before === undefined && after !== undefined;
	const isDeletion = before !== undefined && after === undefined;
	if (!isCreation && !isDeletion) {
		return undefined;
	}

	const userInfoKey = escapeFirestoreKey(localActorId);
	const collection = Notifications(userInfoKey);

	if (isDeletion) {
		const activityIri = before.id;
		if (activityIri === undefined) {
			return undefined;
		}
		const sender = toIdArray(before.actor)[0];
		if (sender === undefined || sender === localActorId) {
			return undefined;
		}
		const types = toTypeArray(before.type);
		const NOTIFICATION_TYPES = ['Follow', 'Create', 'Like', 'Announce'];
		if (!types.some((type) => NOTIFICATION_TYPES.includes(type))) {
			return undefined;
		}

		const ref = collection.doc(escapeFirestoreKey(activityIri));
		const doc = await transaction.get(ref);
		if (!doc.exists) {
			return undefined;
		}
		return () => {
			transaction.delete(ref);
		};
	}

	// 作成
	const candidate = await resolveCandidate(after, (ref) => transaction.get(ref));
	if (candidate === undefined) {
		return undefined;
	}

	const ref = collection.doc(escapeFirestoreKey(candidate.activityIri));
	const byIriRef = MastodonIdsByIri.doc(escapeFirestoreKey(candidate.activityIri));
	const [existingDoc, byIriDoc] = await Promise.all([
		transaction.get(ref),
		transaction.get(byIriRef),
	]);

	if (existingDoc.exists) {
		return undefined;
	}

	const knownMastodonId = byIriDoc.data()?.mastodonId;
	return (mastodonId?: string) => {
		const id = mastodonId ?? knownMastodonId;
		assert(id !== undefined, `notification id is required for ${candidate.activityIri}`);
		const record: NotificationRecord = {
			id,
			type: candidate.type,
			activityIri: candidate.activityIri,
			accountIri: candidate.accountIri,
			statusIri: candidate.statusIri,
			createdAt: serverTimestamp(),
		};
		transaction.set(ref, record);
	};
};

// streams のアクティビティから通知射影を書き直す (→ ADR-0088)。バックフィル用。
export const rebuildNotificationProjection = async ({ dryRun = false } = {}) => {
	const [undoDocs, followDocs, likeDocs, announceDocs, createDocs] = await Promise.all([
		Streams.where('type', '==', 'Undo').get(),
		Streams.where('type', '==', 'Follow').get(),
		Streams.where('type', '==', 'Like').get(),
		Streams.where('type', '==', 'Announce').get(),
		Streams.where('type', '==', 'Create').get(),
	]);

	const undoneIris = new Set(
		undoDocs.docs.flatMap((doc) => {
			const undo = doc.data();
			return isAPUndo(undo) ? toIdArray(undo.object) : [];
		}),
	);

	const allActivities = [
		...followDocs.docs.map((d) => d.data()),
		...likeDocs.docs.map((d) => d.data()),
		...announceDocs.docs.map((d) => d.data()),
		...createDocs.docs.map((d) => d.data()),
	].filter((activity) => activity.id !== undefined && !undoneIris.has(activity.id));

	const noteDocCache = new Map<string, DocumentSnapshot<APObject>>();
	const getNoteDoc = async (ref: DocumentReference<APObject>) => {
		const cached = noteDocCache.get(ref.id);
		if (cached !== undefined) {
			return cached;
		}
		const doc = await ref.get();
		noteDocCache.set(ref.id, doc);
		return doc;
	};

	const candidateResults = await Promise.all(
		allActivities.map((activity) => resolveCandidate(activity, getNoteDoc)),
	);
	const candidates = candidateResults.filter((c): c is NotificationCandidate => c !== undefined);

	const mastodonIds = await getMastodonIds(
		candidates.map((c) => ({
			iri: c.activityIri,
			published: c.published as string | number | undefined,
		})),
	);

	const userInfoKey = escapeFirestoreKey(localActorId);
	const collection = Notifications(userInfoKey);
	const existingDocs = await collection.get();
	const existing = new Map(existingDocs.docs.map((doc) => [doc.id, doc]));

	const stats = {
		written: 0,
		deleted: 0,
		mention: 0,
		favourite: 0,
		reblog: 0,
		follow: 0,
	};

	for (const candidate of candidates) {
		const key = escapeFirestoreKey(candidate.activityIri);
		const existingDoc = existing.get(key);
		existing.delete(key);
		const existingRecord = existingDoc?.data();
		const mastodonId = mastodonIds.get(candidate.activityIri);
		assert(mastodonId !== undefined, `mastodonId not found for ${candidate.activityIri}`);

		let createdAt = existingRecord?.createdAt;
		if (createdAt === undefined) {
			if (typeof candidate.published === 'string' || typeof candidate.published === 'number') {
				const date = new Date(candidate.published);
				if (!Number.isNaN(date.getTime())) {
					createdAt = firebase.firestore.Timestamp.fromDate(date) as unknown as Timestamp;
				}
			}
			if (createdAt === undefined) {
				createdAt = serverTimestamp();
			}
		}

		const record: NotificationRecord = {
			id: mastodonId,
			type: candidate.type,
			activityIri: candidate.activityIri,
			accountIri: candidate.accountIri,
			statusIri: candidate.statusIri,
			createdAt,
		};

		stats[candidate.type]++;
		if (!isEqual(record, existingRecord)) {
			stats.written++;
			if (!dryRun) {
				await collection.doc(key).set(record);
			}
		}
	}

	for (const doc of existing.values()) {
		stats.deleted++;
		if (!dryRun) {
			await doc.ref.delete();
		}
	}

	return stats;
};
