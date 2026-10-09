import express from 'express';
import { mastodonDomain } from '../firebase.js';

// 画像のない Account の `avatar` / `header` に返す既定画像 (→ ADR-0109)。
// Mastodon と同じパスにする。Elk は `header` がこのパスで終わるとヘッダーを描画しない。
const DEFAULT_AVATAR_PATH = '/avatars/original/missing.png';
const DEFAULT_HEADER_PATH = '/headers/original/missing.png';

export const defaultAvatarUrl = `https://${mastodonDomain}${DEFAULT_AVATAR_PATH}`;
export const defaultHeaderUrl = `https://${mastodonDomain}${DEFAULT_HEADER_PATH}`;

// 1×1 の PNG。アバターは単色 (#9baec8)、ヘッダーは透明。
const DEFAULT_AVATAR_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYve4EAAP5AhIiRVY+AAAAAElFTkSuQmCC',
	'base64',
);
const DEFAULT_HEADER_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
	'base64',
);

const sendPng = (res: express.Response, png: Buffer) => {
	res
		.status(200)
		.set({
			'Cache-Control': 'public, max-age=86400, s-maxage=86400',
			'X-Content-Type-Options': 'nosniff',
		})
		.type('image/png')
		.send(png);
};

const router = express.Router();

router.get(DEFAULT_AVATAR_PATH, (_req, res) => {
	sendPng(res, DEFAULT_AVATAR_PNG);
});

router.get(DEFAULT_HEADER_PATH, (_req, res) => {
	sendPng(res, DEFAULT_HEADER_PNG);
});

export default router;
