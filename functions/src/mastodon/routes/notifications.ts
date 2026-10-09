import express from 'express';
import type { DocumentSnapshot, Query } from '@google-cloud/firestore';
import { chunk } from 'lodash-es';
import { z } from 'zod';
import { db, escapeFirestoreKey, mastodonDomain, toFirestoreKey } from '../../firebase.js';
import { isMastodonId } from '../../mastodonId.js';
import type { NotificationRecord } from '../../schema.js';
import { Markers, Notifications } from '../../schema.js';
import { authRequired, getAuthActorId, getLocalActor, scopeRequired } from '../http/auth.js';
import {
	buildLinkHeader,
	isAscending,
	lowerBoundId,
	parsePageParams,
	takePage,
} from '../pagination.js';
import { resolveActorIriByAccountId } from '../presenters/account.js';
import type { NotificationEntity } from '../presenters/notification.js';
import { recordsToNotifications, recordToNotification } from '../presenters/notification.js';

const router = express.Router();

const NOTIFICATIONS_PAGE_LIMITS = { defaultLimit: 40, maxLimit: 80 };
const MAX_NOTIFICATIONS_FETCH_ROUNDS = 5;

const parseStringArray = (value: unknown): string[] => {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string');
	}
	if (typeof value === 'string') {
		return [value];
	}
	return [];
};

const unreadCountLimitSchema = z.coerce.number().int();

// 未読通知数の集計 (→ ADR-0089)
router.get(
	'/v1/notifications/unread_count',
	authRequired,
	scopeRequired('read:notifications'),
	async (req, res) => {
		const parsedLimit = unreadCountLimitSchema.safeParse(req.query.limit);
		const limit = parsedLimit.success ? Math.max(1, Math.min(parsedLimit.data, 1000)) : 100;

		const types = parseStringArray(req.query['types[]'] ?? req.query.types);
		const excludeTypes = parseStringArray(req.query['exclude_types[]'] ?? req.query.exclude_types);
		const accountId = typeof req.query.account_id === 'string' ? req.query.account_id : undefined;

		const actorId = getAuthActorId(res);
		const actorKey = escapeFirestoreKey(actorId);

		const markerDoc = await Markers.doc(toFirestoreKey(`${actorKey}_notifications`)).get();
		const lastReadId = markerDoc.exists ? markerDoc.data()?.lastReadId : undefined;

		// フィルタ指定がない場合は Firestore の count() 集計を活用
		if (types.length === 0 && excludeTypes.length === 0 && accountId === undefined) {
			let q: Query<NotificationRecord> = Notifications(actorKey);
			if (lastReadId !== undefined) {
				q = q.where('id', '>', lastReadId);
			}
			const countSnap = await q.limit(limit).count().get();
			res.json({ count: countSnap.data().count });
			return;
		}

		let targetActorIri: string | undefined;
		if (accountId !== undefined) {
			targetActorIri = await resolveActorIriByAccountId(accountId);
			if (targetActorIri === undefined) {
				res.json({ count: 0 });
				return;
			}
		}

		let q: Query<NotificationRecord> = Notifications(actorKey);
		if (lastReadId !== undefined) {
			q = q.where('id', '>', lastReadId);
		}
		q = q.orderBy('id', 'asc');

		const snap = await q.get();
		let count = 0;
		for (const doc of snap.docs) {
			const data = doc.data();
			if (types.length > 0 && !types.includes(data.type)) {
				continue;
			}
			if (excludeTypes.length > 0 && excludeTypes.includes(data.type)) {
				continue;
			}
			if (targetActorIri !== undefined && data.accountIri !== targetActorIri) {
				continue;
			}
			count++;
			if (count >= limit) {
				break;
			}
		}

		res.json({ count });
	},
);

// Phanpy / Elk 互換スタブ (→ ADR-0067, ADR-0089)
router.get(
	'/v1/notifications/requests',
	authRequired,
	scopeRequired('read:notifications'),
	(_req, res) => {
		res.json([]);
	},
);

router.get(
	'/v2/notifications/policy',
	authRequired,
	scopeRequired('read:notifications'),
	(_req, res) => {
		res.json({
			for_not_following: 'accept',
			for_not_followers: 'accept',
			for_new_accounts: 'accept',
			for_private_mentions: 'filter',
			for_limited_accounts: 'filter',
			summary: {
				pending_requests_count: 0,
				pending_notifications_count: 0,
			},
		});
	},
);

// 全通知削除 (→ ADR-0089)
router.post(
	'/v1/notifications/clear',
	authRequired,
	scopeRequired('write:notifications'),
	async (_req, res) => {
		const actorId = getAuthActorId(res);
		const actorKey = escapeFirestoreKey(actorId);

		const snap = await Notifications(actorKey).get();
		const docChunks = chunk(snap.docs, 500);
		for (const docChunk of docChunks) {
			const batch = db.batch();
			for (const doc of docChunk) {
				batch.delete(doc.ref);
			}
			await batch.commit();
		}

		res.json({});
	},
);

// 1件通知削除 (→ ADR-0089)
router.post(
	'/v1/notifications/:id/dismiss',
	authRequired,
	scopeRequired('write:notifications'),
	async (req, res) => {
		const id = req.params.id;
		if (typeof id !== 'string' || !isMastodonId(id)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actorId = getAuthActorId(res);
		const actorKey = escapeFirestoreKey(actorId);

		const snap = await Notifications(actorKey).where('id', '==', id).limit(1).get();
		const doc = snap.docs[0];
		if (!doc) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		await doc.ref.delete();
		res.json({});
	},
);

// 通知一覧取得 (→ ADR-0089)
router.get(
	'/v1/notifications',
	authRequired,
	scopeRequired('read:notifications'),
	async (req, res) => {
		const page = parsePageParams(req.query, NOTIFICATIONS_PAGE_LIMITS);
		const types = parseStringArray(req.query['types[]'] ?? req.query.types);
		const excludeTypes = parseStringArray(req.query['exclude_types[]'] ?? req.query.exclude_types);
		const accountId = typeof req.query.account_id === 'string' ? req.query.account_id : undefined;

		const actorId = getAuthActorId(res);
		const actorKey = escapeFirestoreKey(actorId);

		let targetActorIri: string | undefined;
		if (accountId !== undefined) {
			targetActorIri = await resolveActorIriByAccountId(accountId);
			if (targetActorIri === undefined) {
				res.json([]);
				return;
			}
		}

		const ascending = isAscending(page);
		const lower = lowerBoundId(page);

		let q: Query<NotificationRecord> = Notifications(actorKey);
		if (page.maxId) {
			q = q.where('id', '<', page.maxId);
		}
		if (lower) {
			q = q.where('id', '>', lower);
		}
		q = q.orderBy('id', ascending ? 'asc' : 'desc');

		const fetchSize = Math.max(page.limit * 2, 40);
		const collectedEntities: NotificationEntity[] = [];
		const scannedIds: string[] = [];
		let lastDoc: DocumentSnapshot<NotificationRecord> | undefined;

		const viewer = await getLocalActor(actorId);

		for (
			let round = 0;
			round < MAX_NOTIFICATIONS_FETCH_ROUNDS && collectedEntities.length < page.limit;
			round++
		) {
			let roundQuery = q.limit(fetchSize);
			if (lastDoc) {
				roundQuery = roundQuery.startAfter(lastDoc);
			}
			const snap = await roundQuery.get();
			if (snap.empty) {
				break;
			}
			lastDoc = snap.docs.at(-1);

			const records = snap.docs.map((d) => d.data());
			const filteredRecords = records.filter((r) => {
				if (types.length > 0 && !types.includes(r.type)) {
					return false;
				}
				if (excludeTypes.length > 0 && excludeTypes.includes(r.type)) {
					return false;
				}
				if (targetActorIri !== undefined && r.accountIri !== targetActorIri) {
					return false;
				}
				return true;
			});
			const entities = new Map(
				(await recordsToNotifications(filteredRecords, viewer)).map((e) => [e.id, e]),
			);

			// limit 件に達したらそこで読むのをやめる。読んだ範囲だけをカーソルにするため (→ ADR-0108)
			for (const r of records) {
				if (collectedEntities.length >= page.limit) {
					break;
				}
				scannedIds.push(r.id);
				const entity = entities.get(r.id);
				if (entity !== undefined) {
					collectedEntities.push(entity);
				}
			}

			if (snap.size < fetchSize) {
				break;
			}
		}

		const resultEntities = takePage(collectedEntities, (e) => e.id, page);

		// Link ヘッダのカーソルは、応答に含めるところまで読んだ範囲の端を採用する (→ ADR-0089, ADR-0108)
		if (scannedIds.length > 0) {
			const sortedScannedIds = [...scannedIds].sort((a, b) => b.localeCompare(a));
			const newestScannedId = sortedScannedIds[0];
			const oldestScannedId = sortedScannedIds.at(-1);
			if (newestScannedId !== undefined && oldestScannedId !== undefined) {
				const link = buildLinkHeader(
					`https://${mastodonDomain}${req.baseUrl}${req.path}`,
					req.query as Record<string, unknown>,
					[newestScannedId, oldestScannedId],
				);
				if (link !== undefined) {
					res.set('Link', link);
				}
			}
		}

		res.json(resultEntities);
	},
);

// 1件通知取得 (→ ADR-0089)
router.get(
	'/v1/notifications/:id',
	authRequired,
	scopeRequired('read:notifications'),
	async (req, res) => {
		const id = req.params.id;
		if (typeof id !== 'string' || !isMastodonId(id)) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const actorId = getAuthActorId(res);
		const actorKey = escapeFirestoreKey(actorId);

		const snap = await Notifications(actorKey).where('id', '==', id).limit(1).get();
		const doc = snap.docs[0];
		if (!doc) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		const viewer = await getLocalActor(actorId);
		const notification = await recordToNotification(doc.data(), viewer);
		if (!notification) {
			res.status(404).json({ error: 'Record not found' });
			return;
		}

		res.json(notification);
	},
);

export default router;
