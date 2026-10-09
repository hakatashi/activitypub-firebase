import express from 'express';
import { authRequired, getAuthUserInfo } from '../http/auth.js';
import { getInstanceV1, getInstanceV2 } from '../instanceInformation.js';
import { resolveAccountSource } from '../presenters/account.js';

const router = express.Router();

router.get('/v1/instance', async (req, res) => {
	res.json(await getInstanceV1());
});

router.get('/v2/instance', async (req, res) => {
	res.json(await getInstanceV2());
});

// ストリーミング API は提供しない (→ ADR-0007)
router.get('/v1/streaming{/*splat}', (req, res) => {
	res.status(404).json({ error: 'Record not found' });
});

router.get('/v1/preferences', authRequired, (req, res) => {
	const source = resolveAccountSource(getAuthUserInfo(res));
	res.send({
		'posting:default:visibility': source.privacy,
		'posting:default:sensitive': source.sensitive,
		'posting:default:language': source.language,
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
