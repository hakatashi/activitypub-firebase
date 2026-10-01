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

	const { publicKey: edPublicKey, privateKey: edPrivateKey } = generateKeyPairSync('ed25519', {
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	});

	let mockStore: IApexStore;
	let apex: ReturnType<typeof ActivitypubExpress>;

	const KEY_ID = 'https://remote.example/u/alice#main-key';
	const ED_KEY_ID = 'https://remote.example/u/alice#ed25519-key';
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

	test('returns 403 when signature header has RFC 9421 syntax but signature-input is missing', async () => {
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

	describe('RFC 9421 HTTP Message Signatures (ADR-0057)', () => {
		test('succeeds for valid POST request with @target-uri and content-digest (RSA-v1_5-SHA256)', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'hello rfc9421' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
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
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('succeeds for valid POST request with @path and @authority instead of @target-uri', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'path authority' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
				components: ['@method', '@path', '@authority', 'content-digest'],
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
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('succeeds for valid GET request without body or content-digest', async () => {
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'GET',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				components: ['@method', '@target-uri'],
			});

			const signer = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
			};
			apex.resolveObject = vi.fn().mockResolvedValue(signer);

			const req = makeReq({
				method: 'GET',
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('succeeds for valid POST request signed with Ed25519 key', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'hello ed25519' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: ED_KEY_ID,
				privateKey: edPrivateKey,
				algorithm: 'ed25519',
				body,
			});

			const signer = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: ED_KEY_ID, owner: ACTOR_ID, publicKeyPem: [edPublicKey] }],
			};
			apex.resolveObject = vi.fn().mockResolvedValue(signer);

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('succeeds for valid POST request signed with RSA-PSS (rsa-pss-sha512)', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'hello rsa-pss' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				algorithm: 'rsa-pss-sha512',
				body,
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
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('succeeds when actor has multiple public keys and resolves key by keyId', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'multiple keys' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: ED_KEY_ID,
				privateKey: edPrivateKey,
				algorithm: 'ed25519',
				body,
			});

			const signer = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [
					{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] },
					{ id: ED_KEY_ID, owner: ACTOR_ID, publicKeyPem: [edPublicKey] },
				],
			};
			apex.resolveObject = vi.fn().mockResolvedValue(signer);

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(signer);
		});

		test('refreshes key when cached key fails and succeeds with rotated key (RFC 9421)', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'key rotation' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
			});

			const cachedSigner = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [otherPublicKey] }],
			};
			const rotatedSigner = {
				id: ACTOR_ID,
				type: 'Person',
				publicKey: [{ id: KEY_ID, owner: ACTOR_ID, publicKeyPem: [publicKey] }],
			};

			apex.resolveObject = vi
				.fn()
				.mockResolvedValueOnce(cachedSigner)
				.mockResolvedValueOnce(rotatedSigner);

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(next).toHaveBeenCalledOnce();
			expect(res.locals.apex.sender).toEqual(rotatedSigner);
			expect(apex.resolveObject).toHaveBeenCalledTimes(2);
		});

		test('returns 403 when signature crypto verification fails (wrong key or tampered signature)', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'bad key' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey: otherPrivateKey,
				body,
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
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when request body does not match content-digest', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'original' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
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
					...rfcHeaders,
				},
				body: { type: 'Create', actor: ACTOR_ID, object: { type: 'Note', content: 'tampered' } },
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when POST request is missing content-digest or digest component', async () => {
			const body = {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'no digest' },
			};
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				components: ['@method', '@target-uri'],
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
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Signature header label does not match Signature-Input label', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					'signature-input': rfcHeaders['signature-input'],
					signature: 'other_label=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig==:',
					'content-digest': rfcHeaders['content-digest'],
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Signature-Input is missing keyid parameter', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const req = makeReq({
				headers: {
					host: 'example.com',
					'signature-input': 'sig1=("@method" "@target-uri" "content-digest");created=1700000000',
					signature: 'sig1=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig==:',
					'content-digest': 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Signature-Input has no components in inner list', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const req = makeReq({
				headers: {
					host: 'example.com',
					'signature-input': `sig1=();created=1700000000;keyid="${KEY_ID}"`,
					signature: 'sig1=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig==:',
					'content-digest': 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Signature-Input omits @method component', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const req = makeReq({
				headers: {
					host: 'example.com',
					'signature-input': `sig1=("@target-uri" "content-digest");created=1700000000;keyid="${KEY_ID}"`,
					signature: 'sig1=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig==:',
					'content-digest': 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when Signature-Input omits target component (@target-uri and @path)', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const req = makeReq({
				headers: {
					host: 'example.com',
					'signature-input': `sig1=("@method" "content-digest");created=1700000000;keyid="${KEY_ID}"`,
					signature: 'sig1=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig==:',
					'content-digest': 'sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:',
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when created timestamp is in the future beyond clock skew', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const futureTime = Math.floor(Date.now() / 1000) + 2 * 3600;
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
				created: futureTime,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when created timestamp is older than 13 hours', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const oldTime = Math.floor(Date.now() / 1000) - 14 * 3600;
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
				created: oldTime,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when expires timestamp is in the past beyond clock skew margin', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const createdTime = Math.floor(Date.now() / 1000) - 3 * 3600;
			const expiresTime = Math.floor(Date.now() / 1000) - 2 * 3600;
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
				created: createdTime,
				expires: expiresTime,
			});

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('returns 403 when signer cannot be resolved', async () => {
			const body = { type: 'Create', actor: ACTOR_ID };
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
			});

			apex.resolveObject = vi.fn().mockResolvedValue(null);

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(next).not.toHaveBeenCalled();
		});

		test('ignores unverifiable Delete from tombstoned actor (returns 200)', async () => {
			const body = { type: 'Delete', actor: ACTOR_ID };
			const rfcHeaders = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url: 'https://example.com/u/hakatashi/inbox',
				keyId: KEY_ID,
				privateKey,
				body,
			});

			apex.resolveObject = vi.fn().mockResolvedValue({ type: 'Tombstone' });

			const req = makeReq({
				headers: {
					host: 'example.com',
					...rfcHeaders,
				},
				body,
			});
			const res = makeRes();
			const next = vi.fn();

			await apex.net.security.verifySignature(req, res, next);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(next).not.toHaveBeenCalled();
		});

		test('successfully verifies Mastodon reference test vector end-to-end', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2023-12-20T10:00:00Z'));
			try {
				const mastodonPublicKey = `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqIAYvNFGbZ5g4iiK6feS\ndXD4bDStFM58A7tHycYXaYtzZQpIeHXAmaXuZzXIwtrP4N0gIk8JNwZvXj2UPS+S\n07t0V9wNK94he01LV5EMz/GN4eNnFmDL64HIEuKLvV8TvgjbUPRD6Y5X0UpKi2ZI\nFLSb96Q5w0Z/k7ntpVKV52y8kz5Fjr/O/0JuHryZe0yItzJh8kzFfeMf0EXzfSna\nKvT7P9jhgC6uTre+jXyvVZjiHDrnqvvucdI3I7DRfXo1OqARBrLjy+TdseUAjNYJ\n+OuPRI1URIWQI01DCHqcohVu9+Ar+BiCjFp3ua+XMuJvrvbD61d1Fvig/9nbBRR+\n8QIDAQAB\n-----END PUBLIC KEY-----`;

				const bobActorId = 'https://remote.domain/users/bob';
				const bobKeyId = 'https://remote.domain/users/bob#main-key';
				const signer = {
					id: bobActorId,
					type: 'Person',
					publicKey: [{ id: bobKeyId, owner: bobActorId, publicKeyPem: [mastodonPublicKey] }],
				};
				apex.resolveObject = vi.fn().mockResolvedValue(signer);

				const req = makeReq({
					url: 'https://www.example.com/activitypub/success',
					originalUrl: 'https://www.example.com/activitypub/success',
					method: 'POST',
					headers: {
						host: 'www.example.com',
						'content-digest': 'sha-256=:ZOyIygCyaOW6GjVnihtTFtIS9PNmskdyMlNKiuyjfzw=:',
						'signature-input':
							'sig1=("@method" "@target-uri" "content-digest");created=1703066400;keyid="https://remote.domain/users/bob#main-key"',
						signature:
							'sig1=:c4jGY/PnOV4CwyvNnAmY6NLX0sf6EtbKu7kYseNARRZaq128PrP0GNQ4cd3XsX9cbMfJMw1ntI4zuEC81ncW8g+90OHP02bX0LkT57RweUtN4CSA01hRqSVe/MW32tjGixCiItvWqjNHoIZnZApu1bd+M3zMR+VCEue4/8a0D2eRrvfQxJUUBXZR1ZTRFlf1LNFDW3U7cuTbAKYr2zWVr7on+h2vA+vzEND9WE8z1SHd6SIFFgP0QRqrCXYx+vsTs3aLusTsamRWissoycJGexb64mI9iqiD8SD+uN1xk6iRU3nkUmhUquugjlOFyjxbbLo5ZnYjsECMt/BW+Catxw==:',
					},
					body: 'Hello world',
					rawBody: 'Hello world',
				});
				const res = makeRes();
				const next = vi.fn();

				await apex.net.security.verifySignature(req, res, next);

				expect(next).toHaveBeenCalledOnce();
				expect(res.locals.apex.sender).toEqual(signer);
			} finally {
				vi.useRealTimers();
			}
		});
	});
});
