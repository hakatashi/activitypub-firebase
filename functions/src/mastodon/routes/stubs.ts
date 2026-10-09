import express from 'express';
import { authRequired, scopeRequired } from '../http/auth.js';

const router = express.Router();

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

router.get('/v1/follow_requests', authRequired, scopeRequired('read:follows'), (req, res) => {
	res.json([]);
});

router.get('/v1/featured_tags', authRequired, scopeRequired('read:accounts'), (req, res) => {
	res.json([]);
});

router.get('/v1/accounts/:id/featured_tags', (req, res) => {
	res.json([]);
});

// 共通のフォロワーは数えない。問い合わせた id ごとに空の一覧を返す (Phanpy のプロフィールが叩く)
router.get(
	'/v1/accounts/familiar_followers',
	authRequired,
	scopeRequired('read:follows'),
	(req, res) => {
		const ids = [req.query.id].flat().filter((id): id is string => typeof id === 'string');
		res.json(ids.map((id) => ({ id, accounts: [] })));
	},
);

export default router;
