import firebase from 'firebase-admin';
import { z } from 'zod';
import { db, escapeFirestoreKey, toFirestoreKey } from '../../firebase.js';
import { Markers } from '../../schema.js';
import { createAsyncRouter } from '../http/asyncRouter.js';
import { authRequired, getAuthActorId, scopeRequired } from '../http/auth.js';

const router = createAsyncRouter();

export const markersQuerySchema = z.object({
	timeline: z.union([z.string(), z.array(z.string())]).optional(),
});

export const markerTimelineSchema = z.object({
	last_read_id: z.string().min(1),
	version: z.coerce.number().int().optional(),
});

export const createMarkersBodySchema = z.object({
	home: markerTimelineSchema.optional(),
	notifications: markerTimelineSchema.optional(),
});

router.get('/v1/markers', authRequired, scopeRequired('read:statuses'), async (req, res) => {
	const parsedQuery = markersQuerySchema.safeParse(req.query);
	if (!parsedQuery.success) {
		res.status(400).send('Bad request');
		return;
	}

	const requestedTimelines = parsedQuery.data.timeline
		? (Array.isArray(parsedQuery.data.timeline)
				? parsedQuery.data.timeline
				: [parsedQuery.data.timeline]
			).filter((t): t is 'home' | 'notifications' => t === 'home' || t === 'notifications')
		: [];

	if (requestedTimelines.length === 0) {
		res.json({});
		return;
	}

	const actorId = getAuthActorId(res);
	const docRefs = requestedTimelines.map((timeline) => ({
		timeline,
		ref: Markers.doc(toFirestoreKey(`${escapeFirestoreKey(actorId)}_${timeline}`)),
	}));

	const docs = await Promise.all(docRefs.map(({ ref }) => ref.get()));
	const result: Record<
		string,
		{
			last_read_id: string;
			version: number;
			updated_at: string;
		}
	> = {};

	for (let i = 0; i < docRefs.length; i++) {
		const item = docRefs[i]!;
		const doc = docs[i];
		if (doc && doc.exists) {
			const data = doc.data()!;
			result[item.timeline] = {
				last_read_id: data.lastReadId,
				version: data.version,
				updated_at: data.updatedAt.toDate().toISOString(),
			};
		}
	}

	res.json(result);
});

router.post('/v1/markers', authRequired, scopeRequired('write:statuses'), async (req, res) => {
	const parsedBody = createMarkersBodySchema.safeParse(req.body);
	if (!parsedBody.success) {
		res.status(400).send('Bad request');
		return;
	}

	const data = parsedBody.data;
	const timelines: ('home' | 'notifications')[] = [];
	if (data.home) {
		timelines.push('home');
	}
	if (data.notifications) {
		timelines.push('notifications');
	}

	if (timelines.length === 0) {
		res.json({});
		return;
	}

	const actorId = getAuthActorId(res);

	try {
		const markersResult = await db.runTransaction(async (transaction) => {
			const result: Record<
				string,
				{
					last_read_id: string;
					version: number;
					updated_at: string;
				}
			> = {};

			const docRefs = timelines.map((t) => ({
				timeline: t,
				input: data[t]!,
				ref: Markers.doc(toFirestoreKey(`${escapeFirestoreKey(actorId)}_${t}`)),
			}));

			const docs = await Promise.all(docRefs.map(({ ref }) => transaction.get(ref)));

			for (let i = 0; i < docRefs.length; i++) {
				const { timeline, input, ref } = docRefs[i]!;
				const doc = docs[i];
				const now = firebase.firestore.Timestamp.now();
				if (doc && doc.exists) {
					const existing = doc.data()!;
					if (input.version !== undefined && input.version !== existing.version) {
						const error = new Error('Conflict during update, please try again');
						(error as { code?: string }).code = 'STALE_OBJECT';
						throw error;
					}
					const newVersion = existing.version + 1;
					transaction.set(ref, {
						actorId,
						timeline,
						lastReadId: input.last_read_id,
						version: newVersion,
						updatedAt: now,
					});
					result[timeline] = {
						last_read_id: input.last_read_id,
						version: newVersion,
						updated_at: now.toDate().toISOString(),
					};
				} else {
					const newVersion = 1;
					transaction.set(ref, {
						actorId,
						timeline,
						lastReadId: input.last_read_id,
						version: newVersion,
						updatedAt: now,
					});
					result[timeline] = {
						last_read_id: input.last_read_id,
						version: newVersion,
						updated_at: now.toDate().toISOString(),
					};
				}
			}
			return result;
		});

		res.json(markersResult);
	} catch (error) {
		const err = error as { code?: string | number };
		if (err.code === 'STALE_OBJECT' || err.code === 10 /* ABORTED */) {
			res.status(409).json({ error: 'Conflict during update, please try again' });
			return;
		}
		throw error;
	}
});

export default router;
