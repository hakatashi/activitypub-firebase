import { generateKeyPairSync } from 'node:crypto';
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
		body?: Record<string, unknown>;
		env?: string;
	}) => {
		const headers = Object.fromEntries(
			Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
		);
		const req = {
			method: options.method ?? 'POST',
			url: options.url ?? '/u/hakatashi/inbox',
			originalUrl: options.originalUrl ?? options.url ?? '/u/hakatashi/inbox',
			headers,
			get: (name: string) => headers[name.toLowerCase()],
			body: options.body ?? {
				type: 'Create',
				actor: ACTOR_ID,
				object: { type: 'Note', content: 'hello' },
			},
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
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
			digest: 'SHA-256=abcdef',
		});

		// Omit the digest header from the request
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

	test('returns 500 when resolving the signer encounters a network/system error', async () => {
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
		});

		apex.resolveObject = vi.fn().mockRejectedValue(new Error('Connection timed out'));

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

		expect(res.status).toHaveBeenCalledWith(500);
		expect(next).not.toHaveBeenCalled();
	});

	test('returns 403 when signer has no public key', async () => {
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
		});

		apex.resolveObject = vi.fn().mockResolvedValue({ id: ACTOR_ID, type: 'Person' });

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

	test('returns 403 when signature is invalid (tampered or wrong key)', async () => {
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: otherPrivateKey, // Signed with other key
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
				signature,
			},
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(next).not.toHaveBeenCalled();
	});

	test('successfully verifies valid draft-cavage signature with Signature header', async () => {
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
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
			},
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(res.locals.apex.sender).toEqual(signer);
		expect(res.status).not.toHaveBeenCalled();
	});

	test('successfully verifies valid draft-cavage signature with Authorization header', async () => {
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
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
				authorization: `Signature ${signature}`,
			},
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(res.locals.apex.sender).toEqual(signer);
	});

	test('refreshes key when cached key fails and succeeds with rotated key', async () => {
		const { signature, date } = apex.computeHttpSignatureHeaders({
			method: 'post',
			url: 'https://example.com/u/hakatashi/inbox',
			keyId: KEY_ID,
			privateKeyPem: privateKey,
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
				signature,
			},
		});
		const res = makeRes();
		const next = vi.fn();

		await apex.net.security.verifySignature(req, res, next);

		expect(apex.resolveObject).toHaveBeenCalledTimes(2);
		expect(next).toHaveBeenCalledOnce();
		expect(res.locals.apex.sender).toEqual(refreshedSigner);
	});
});
