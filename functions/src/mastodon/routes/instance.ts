import { createAsyncRouter } from '../http/asyncRouter.js';
import { authRequired } from '../http/auth.js';
import { getInstanceV1, getInstanceV2 } from '../instanceInformation.js';

const router = createAsyncRouter();

router.get('/v1/instance', async (req, res) => {
	res.json(await getInstanceV1());
});

router.get('/v2/instance', async (req, res) => {
	res.json(await getInstanceV2());
});

// ストリーミング API は提供しない (→ ADR-0007)
router.get('/v1/streaming', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

router.get('/v1/streaming/*', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

router.get('/v1/preferences', authRequired, (req, res) => {
	res.send({
		'posting:default:visibility': 'public',
		'posting:default:sensitive': false,
		'posting:default:language': 'ja',
		'reading:expand:media': 'show_all',
		'reading:expand:spoilers': true,
	});
});

router.get('/v1/push/subscription', authRequired, (req, res) => {
	res.status(404).json({
		error: 'Record not found',
	});
});

export default router;
