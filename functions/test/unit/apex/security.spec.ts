import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

describe('apex net/security verifySignature', () => {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	let mockStore: IApexStore;
	let apex: ReturnType<typeof ActivitypubExpress>;

	const KEY_ID = 'https://remote.example/u/alice#main-key';
	const ACTOR_ID = 'https://remote.example/u/alice';

	const computeDigest = (body: Buffer | string | Record<string, unknown>) => {
		const buf = Buffer.isBuffer(body)
			? body
			: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
		return `SHA-256=${createHash('sha256').update(buf).digest('base64')}`;
	};

	beforeEach(() => {
		mockStore = {} as IApexStore;
		apex = ActivitypubExpress({
			name: 'test-apex',
			version: '1.0.0',
			domain: 'example.com',
			actorParam: 'actor',
			objectParam: 'id',
			activityParam: 'id',
			routes: {
				actor: '/u/:actor',
				object: '/o/:id',
				activity: '/s/:id',
				inbox: '/u/:actor/inbox',
				outbox: '/u/:actor/outbox',
				followers: '/u/:actor/followers',
				following: '/u/:actor/following',
				liked: '/u/:actor/liked',
				collections: '/u/:actor/c/:id',
				blocked: '/u/:actor/blocked',
				rejections: '/u/:actor/rejections',
				rejected: '/u/:actor/rejected',
				shares: '/s/:id/shares',
				likes: '/s/:id/likes',
			},
			logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
			store: mockStore,
			offlineMode: false,
		});
	});

	const makeReq = (options: {
		method?: string;
		url?: string;
		originalUrl?: string;
		headers?: Record<string, string>;
		body?: unknown;
		rawBody?: Buffer | string;
		env?: string;
	}) => {
		const headers = Object.fromEntries(
			Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		const body = options.body ?? {
			type: 'Create',
			actor: ACTOR_ID,
			object: { type: 'Note', content: 'hello' },
		};
		let rawBody: Buffer;
		if (options.rawBody === undefined) {
			rawBody = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
		} else if (Buffer.isBuffer(options.rawBody)) {
			rawBody = options.rawBody;
		} else {
			rawBody = Buffer.from(options.rawBody, 'utf-8');
		}
		const req = {
			method: options.method ?? 'POST',
			url: options.url ?? '/u/hakatashi/inbox',
			originalUrl: options.originalUrl ?? options.url ?? '/u/hakatashi/inbox',
			headers,
			get: (name: string) => headers[name.toLowerCase()],
			body,
			rawBody,
			app: {
				get: (setting: string) => (setting === 'env' ? (options.env ?? 'production') : undefined),
				locals: { apex },
			},
		} as unknown as Request;
		return req;
	};

	const makeRes = () => {
		const res = {
			locals: { apex: {} },
			status: vi.fn().mockReturnThis(),
			send: vi.fn().mockReturnThis(),
			sendStatus: vi.fn().mockReturnThis(),
		};
		return res as unknown as Response & {
			status: typeof res.status;
			send: typeof res.send;
			sendStatus: typeof res.sendStatus;
		};
	};

	test('returns 401 when signature header is missing in production', async () => {
		const req = makeReq({ headers: {}, env: 'production' });
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(next).not.toHaveBeenCalled();
	});

	test('allows missing signature header in development mode', async () => {
		const actor = { id: ACTOR_ID, type: 'Person' };
		apex.resolveObject = vi.fn().mockResolvedValue(actor);

		const req = makeReq({ headers: {}, env: 'development' });
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(res.locals.apex.sender).toEqual(actor);
	});

	test('returns 403 for RFC 9421 style signature header', async () => {
		const req = makeReq({
			headers: {
				signature: 'sig1=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig==:',
			},
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();
	});

	test('returns 403 when signature header is missing required keyId parameter', async () => {
		const req = makeReq({
			headers: {
				signature: 'algorithm="rsa-sha256",headers="(request-target) host date",signature="abc"',
			},
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();
	});

	test('returns 403 when a signed header is missing from the request', async () => {
		const body = { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'hello' } };
		const digest = computeDigest(body);
		const { signature } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
			digest,
		});

		// Omit the date header from the request
		const req = makeReq({
			headers: {
				host: 'example.com',
				digest,
				signature,
			},
			body,
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();
	});

	test('returns 500 when resolving the signer encounters a network/system error', async () => {
		const body = { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'hello' } };
		const digest = computeDigest(body);
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
			digest,
		});

		apex.resolveObject = vi.fn().mockRejectedValue(new Error('Connection timed out'));

		const req = makeReq({
			headers: {
				host: 'example.com',
				date,
				digest,
				signature,
			},
			body,
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(500);
		expect(next).not.toHaveBeenCalled();
	});

	test('returns 403 when signer has no public key', async () => {
		const body = { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'hello' } };
		const digest = computeDigest(body);
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
			digest,
		});

		apex.resolveObject = vi.fn().mockResolvedValue({ id: ACTOR_ID, type: 'Person' });

		const req = makeReq({
			headers: {
				host: 'example.com',
				date,
				digest,
				signature,
			},
			body,
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();
	});

	test('returns 403 when signature is invalid (tampered or wrong key)', async () => {
		const body = { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'hello' } };
		const digest = computeDigest(body);
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: otherPrivateKey, // Signed with other key
			digest,
		});

		apex.resolveObject = vi.fn().mockResolvedValue({
			id: ACTOR_ID,
			type: 'Person',
			publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
		});

		const req = makeReq({
			headers: {
				host: 'example.com',
				date,
				digest,
				signature,
			},
			body,
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();
	});

	test('successfully verifies valid draft-cavage signature with Signature header', async () => {
		const body = { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'hello' } };
		const digest = computeDigest(body);
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
			digest,
		});

		const signer = {
			id: ACTOR_ID,
			type: 'Person',
			publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
		};
		apex.resolveObject = vi.fn().mockResolvedValue(signer);

		const req = makeReq({
			headers: {
				host: 'example.com',
				date,
				digest,
				signature,
			},
			body,
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(res.locals.apex.sender).toEqual(signer);
		expect(res.status).not.toHaveBeenCalled();
	});

	test('successfully verifies valid draft-cavage signature with Authorization header', async () => {
		const body = { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'hello' } };
		const digest = computeDigest(body);
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
			digest,
		});

		const signer = {
			id: ACTOR_ID,
			type: 'Person',
			publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
		};
		apex.resolveObject = vi.fn().mockResolvedValue(signer);

		const req = makeReq({
			headers: {
				host: 'example.com',
				date,
				digest,
				authorization: `Signature ${signature}`,
			},
			body,
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(res.locals.apex.sender).toEqual(signer);
	});

	test('refreshes key when cached key fails and succeeds with rotated key', async () => {
		const body = { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'hello' } };
		const digest = computeDigest(body);
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
			digest,
		});

		const staleSigner = {
			id: ACTOR_ID,
			type: 'Person',
			publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [otherPublicKey] }],
		};
		const refreshedSigner = {
			id: ACTOR_ID,
			type: 'Person',
			publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
		};

		apex.resolveObject = vi
			.fn()
			.mockResolvedValueOnce(staleSigner) // First call (cached)
			.mockResolvedValueOnce(refreshedSigner); // Second call (fresh)

		const req = makeReq({
			headers: {
				host: 'example.com',
				date,
				digest,
				signature,
			},
			body,
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(apex.resolveObject).toHaveBeenCalledTimes(2);
		expect(next).toHaveBeenCalledOnce();
		expect(res.locals.apex.sender).toEqual(refreshedSigner);
	});

	describe('signature strength verification (ADR-0056)', () => {
		test('returns 403 when signature header does not include date or (created)', async () => {
			const req = makeReq({
				headers: {
					host: 'example.com',
					date: new Date().toUTCString(),
					signature: `keyId="${KEY_ID}",algorithm="rsa-sha256",headers="(request-target) host",signature="abc"`,
				},
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when POST request signature does not include digest header', async () => {
			const { signature, date } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				// digest omitted
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					date,
					signature,
				},
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});
	});

	describe('digest verification (ADR-0056)', () => {
		test('returns 403 when Digest header is missing in request but signed', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const digest = computeDigest(body);
			const { signature, date } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				digest,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					date,
					signature,
					// Digest header omitted from req
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Digest header does not include sha-256', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const { signature, date } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				digest: 'MD5=some-md5-digest',
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					date,
					signature,
					digest: 'MD5=some-md5-digest',
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when request body does not match Digest header', async () => {
			const originalBody = { type: 'Create', actor: ACTOR_ID, object: 'valid' };
			const tamperedBody = { type: 'Create', actor: ACTOR_ID, object: 'tampered' };
			const originalDigest = computeDigest(originalBody);

			const { signature, date } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				digest: originalDigest,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					date,
					signature,
					digest: originalDigest,
				},
				body: tamperedBody, // Tampered body
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('succeeds when Digest header contains multiple comma-separated algorithms including sha-256', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const sha256Digest = computeDigest(body);
			const multipleDigests = `MD5=X48E9qO=, ${sha256Digest}, SHA-512=xyz=`;

			const { signature, date } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				digest: multipleDigests,
			});

			const signer = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
			};
			apex.resolveObject = vi.fn().mockResolvedValue(signer);

			const req = makeReq({
				headers: {
					host: 'example.com',
					date,
					signature,
					digest: multipleDigests,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('verifies Digest using req.rawBody even when req.body is compacted or transformed', async () => {
			const rawJson = '{"@context":"https://www.w3.org/ns/activitystreams","type":"Create"}';
			const rawDigest = computeDigest(rawJson);

			const { signature, date } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				digest: rawDigest,
			});

			const signer = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
			};
			apex.resolveObject = vi.fn().mockResolvedValue(signer);

			// req.body has transformed object (e.g. from JSON-LD expansion/compaction)
			// while rawBody contains original JSON string
			const req = makeReq({
				headers: {
					host: 'example.com',
					date,
					signature,
					digest: rawDigest,
				},
				body: { type: 'Create', actor: ACTOR_ID, customTransformedField: true },
				rawBody: Buffer.from(rawJson, 'utf-8'),
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});
	});

	describe('date and time window verification (ADR-0056)', () => {
		test('returns 403 when Date header is unparseable', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const digest = computeDigest(body);
			const invalidDate = 'invalid-date-string';

			const { signature } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				date: invalidDate,
				digest,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					date: invalidDate,
					signature,
					digest,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Date header is more than 1 hour in the future', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const digest = computeDigest(body);
			// 2 hours in the future
			const futureDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toUTCString();

			const { signature } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				date: futureDate,
				digest,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					date: futureDate,
					signature,
					digest,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Date header is older than 13 hours (12h expiration limit + 1h skew)', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const digest = computeDigest(body);
			// 14 hours in the past
			const oldDate = new Date(Date.now() - 14 * 60 * 60 * 1000).toUTCString();

			const { signature } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				date: oldDate,
				digest,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					date: oldDate,
					signature,
					digest,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('succeeds when Date header is within acceptable window (e.g. 5 hours ago)', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const digest = computeDigest(body);
			// 5 hours in the past
			const acceptableDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toUTCString();

			const { signature } = apex.computeHttpSignatureHeaders({
				method: 'post',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKeyPem: privateKey,
				date: acceptableDate,
				digest,
			});

			const signer = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
			};
			apex.resolveObject = vi.fn().mockResolvedValue(signer);

			const req = makeReq({
				headers: {
					host: 'example.com',
					date: acceptableDate,
					signature,
					digest,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('succeeds when (created) pseudo-header is signed instead of date', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const digest = computeDigest(body);
			const createdTime = Math.floor((Date.now() - 60 * 1000) / 1000); // 1 minute ago

			// Build signature with (created)
			const stringToSign = [
				'(request-target): post /u/hakatashi/inbox',
				'host: example.com',
				`(created): ${createdTime}`,
				`digest: ${digest}`,
			].join('\n');
			const sigBuf = Buffer.from(stringToSign, 'utf-8');
			const signatureBytes = sign('sha256', sigBuf, privateKey).toString('base64');

			const signatureHeader = `keyId="${KEY_ID}",algorithm="rsa-sha256",created="${createdTime}",headers="(request-target) host (created) digest",signature="${signatureBytes}"`;

			const signer = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
			};
			apex.resolveObject = vi.fn().mockResolvedValue(signer);

			const req = makeReq({
				headers: {
					host: 'example.com',
					signature: signatureHeader,
					digest,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('returns 403 when expires parameter is in the past beyond clock skew margin', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const digest = computeDigest(body);
			const createdTime = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000); // 3 hours ago
			const expiresTime = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000); // Expired 2 hours ago (> 1 hour skew)

			const stringToSign = [
				'(request-target): post /u/hakatashi/inbox',
				'host: example.com',
				`(created): ${createdTime}`,
				`digest: ${digest}`,
			].join('\n');
			const sigBuf = Buffer.from(stringToSign, 'utf-8');
			const signatureBytes = sign('sha256', sigBuf, privateKey).toString('base64');

			const signatureHeader = `keyId="${KEY_ID}",algorithm="rsa-sha256",created="${createdTime}",expires="${expiresTime}",headers="(request-target) host (created) digest",signature="${signatureBytes}"`;

			const req = makeReq({
				headers: {
					host: 'example.com',
					signature: signatureHeader,
					digest,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});
	});
});
