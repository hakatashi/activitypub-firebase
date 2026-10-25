import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isKnownBenignError, isKnownBenignRequest } from './allowlist.mjs';

const SERVER = 'mastodon-dev.hakatashi.com';

describe('isKnownBenignRequest', () => {
	it('matches Web Push 404', () => {
		const match = isKnownBenignRequest({
			method: 'GET',
			status: 404,
			url: `https://${SERVER}/api/v1/push/subscription`,
		}, SERVER);
		assert.ok(match);
		assert.match(match.reason, /Web Push subscription 404/);
	});

	it('does not match Web Push 500 or POST 404', () => {
		assert.equal(
			isKnownBenignRequest({
				method: 'GET',
				status: 500,
				url: `https://${SERVER}/api/v1/push/subscription`,
			}, SERVER),
			null,
		);
		assert.equal(
			isKnownBenignRequest({
				method: 'POST',
				status: 404,
				url: `https://${SERVER}/api/v1/push/subscription`,
			}, SERVER),
			null,
		);
	});

	it('does not match regular API 404', () => {
		assert.equal(
			isKnownBenignRequest({
				method: 'GET',
				status: 404,
				url: `https://${SERVER}/api/v1/accounts/12345`,
			}, SERVER),
			null,
		);
	});

	it('matches blob URLs', () => {
		const match1 = isKnownBenignRequest({
			method: 'GET',
			status: null,
			url: 'blob:http://127.0.0.1:5315/abcd-efgh',
			failure: 'net::ERR_FILE_NOT_FOUND',
		}, SERVER);
		assert.ok(match1);

		const match2 = isKnownBenignRequest({
			method: 'GET',
			status: null,
			url: 'blob:http://127.0.0.1:5315/1234',
			failure: null,
		}, SERVER);
		assert.ok(match2);
	});

	it('matches remote media CORS / network failures', () => {
		const match = isKnownBenignRequest({
			method: 'GET',
			status: null,
			url: 'https://img.pawoo.net/accounts/avatars/000/001/458/original/3d6b1dd5c805ea72.png',
			failure: 'net::ERR_FAILED',
		}, SERVER);
		assert.ok(match);
		assert.match(match.reason, /External third-party resource/);
	});

	it('matches external resource rate limits or HTTP errors', () => {
		const match = isKnownBenignRequest({
			method: 'GET',
			status: 429,
			url: 'https://opengraph.githubassets.com/654cfb039e74c6f4e4a2151451c7009907c745c5818d5c851be95ad8b08d64ed/hakatashi/activitypub-firebase/issues/320',
		}, SERVER);
		assert.ok(match);
		assert.match(match.reason, /External third-party resource/);
	});

	it('matches GCS avatar edge cache failures', () => {
		const match = isKnownBenignRequest({
			method: 'GET',
			status: null,
			url: `https://${SERVER}/system/accounts/avatars/123/original/abc.png`,
			failure: 'net::ERR_FAILED',
		}, SERVER);
		assert.ok(match);
	});

	it('does not match dev API network failure', () => {
		assert.equal(
			isKnownBenignRequest({
				method: 'GET',
				status: null,
				url: `https://${SERVER}/api/v1/timelines/home`,
				failure: 'net::ERR_FAILED',
			}, SERVER),
			null,
		);
	});
});

describe('isKnownBenignError', () => {
	it('matches AbortError', () => {
		const match = isKnownBenignError({
			type: 'pageerror',
			text: 'AbortError: signal is aborted without reason',
		});
		assert.ok(match);
		assert.match(match.reason, /Navigation fetch abort/);
	});

	it('matches CORS policy console errors', () => {
		const match = isKnownBenignError({
			type: 'console',
			text: "Access to image at 'https://misskey-test.hakatashi.com/identicon/admin' from origin 'http://127.0.0.1:5315' has been blocked by CORS policy",
		});
		assert.ok(match);
		assert.match(match.reason, /CORS/);
	});

	it('does not match unexpected page errors', () => {
		assert.equal(
			isKnownBenignError({
				type: 'pageerror',
				text: 'TypeError: Cannot read properties of undefined',
			}),
			null,
		);
	});
});
