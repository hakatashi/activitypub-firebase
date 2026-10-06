import { createAsyncRouter } from '../http/asyncRouter.js';
import { authRequired, getAuthActorId, getLocalActor, getOptionalViewer } from '../http/auth.js';
import { respondWithStatuses } from '../http/responses.js';
import { parsePageParams } from '../pagination.js';
import { STATUS_PAGE_LIMITS, getHomeTimeline, getPublicTimeline } from '../presenters/status.js';

const router = createAsyncRouter();

router.get('/v1/timelines/public', async (req, res) => {
	const viewer = await getOptionalViewer(req, res);
	respondWithStatuses(
		req,
		res,
		await getPublicTimeline(parsePageParams(req.query, STATUS_PAGE_LIMITS), viewer),
	);
});

router.get('/v1/timelines/home', authRequired, async (req, res) => {
	const viewer = await getLocalActor(getAuthActorId(res));
	respondWithStatuses(
		req,
		res,
		await getHomeTimeline(viewer, parsePageParams(req.query, STATUS_PAGE_LIMITS)),
	);
});

export default router;
