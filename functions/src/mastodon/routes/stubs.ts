import { createAsyncRouter } from '../http/asyncRouter.js';
import { authRequired, scopeRequired } from '../http/auth.js';

const router = createAsyncRouter();

// クライアント起動用の空配列スタブ (→ ADR-0004, ADR-0067)
router.get('/v1/custom_emojis', (req, res) => {
	res.json([]);
});

router.get('/v1/filters', authRequired, scopeRequired('read:filters'), (req, res) => {
	res.json([]);
});

router.get('/v2/filters', authRequired, scopeRequired('read:filters'), (req, res) => {
	res.json([]);
});

router.get('/v1/announcements', authRequired, scopeRequired('read:statuses'), (req, res) => {
	res.json([]);
});

router.get('/v1/lists', authRequired, scopeRequired('read:lists'), (req, res) => {
	res.json([]);
});

router.get('/v1/followed_tags', authRequired, scopeRequired('read:follows'), (req, res) => {
	res.json([]);
});

router.get('/v1/conversations', authRequired, scopeRequired('read:statuses'), (req, res) => {
	res.json([]);
});

router.get('/v1/blocks', authRequired, scopeRequired('read:blocks'), (req, res) => {
	res.json([]);
});

router.get('/v1/mutes', authRequired, scopeRequired('read:mutes'), (req, res) => {
	res.json([]);
});

router.get('/v1/domain_blocks', authRequired, scopeRequired('read:blocks'), (req, res) => {
	res.json([]);
});

router.get('/v1/bookmarks', authRequired, scopeRequired('read:bookmarks'), (req, res) => {
	res.json([]);
});

router.get('/v1/favourites', authRequired, scopeRequired('read:favourites'), (req, res) => {
	res.json([]);
});

router.get('/v1/follow_requests', authRequired, scopeRequired('read:follows'), (req, res) => {
	res.json([]);
});

router.get('/v1/featured_tags', authRequired, scopeRequired('read:accounts'), (req, res) => {
	res.json([]);
});

router.get('/v1/accounts/:id/featured_tags', (req, res) => {
	res.json([]);
});

export default router;
