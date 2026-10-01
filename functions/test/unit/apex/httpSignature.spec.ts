import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import ActivitypubExpress from '../../../src/apex/index.js';
import type IApexStore from '../../../src/apex/store/interface.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('apex computeHttpSignatureHeaders', () => {
	const mockStore = {} as IApexStore;
	const apex = ActivitypubExpress({
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

	test('produces a GET signature verifiable against the reconstructed signing string', () => {
		const url = new URL('https://remote.example/activitypub/o/some-object?x=1');
		const { date, signature } = apex.computeHttpSignatureHeaders({
			method: 'get',
			url,
			privateKeyPem: privateKey,
			keyId: 'https://example.com/u/alice#main-key',
		});

		expect(signature).toContain('keyId="https://example.com/u/alice#main-key"');
		expect(signature).toContain('algorithm="rsa-sha256"');
		expect(signature).toContain('headers="(request-target) host date"');

		const signatureMatch = /signature="(?<value>[^"]+)"/.exec(signature);
		expect(signatureMatch).not.toBeNull();
		const signatureBase64 = signatureMatch?.groups?.value;

		const stringToSign = [
			`(request-target): get ${url.pathname}${url.search}`,
			`host: ${url.host}`,
			`date: ${date}`,
		].join('\n');

		const isValid = verify(
			'sha256',
			Buffer.from(stringToSign, 'utf-8'),
			publicKey,
			Buffer.from(signatureBase64 ?? '', 'base64'),
		);
		expect(isValid).toBe(true);
	});

	test('produces a POST signature verifiable with digest', () => {
		const url = new URL('https://remote.example/inbox');
		const digest = 'SHA-256=abcdef123456';
		const {
			date,
			signature,
			digest: resDigest,
		} = apex.computeHttpSignatureHeaders({
			method: 'post',
			url,
			privateKeyPem: privateKey,
			keyId: 'https://example.com/u/alice#main-key',
			digest,
		});

		expect(resDigest).toBe(digest);
		expect(signature).toContain('keyId="https://example.com/u/alice#main-key"');
		expect(signature).toContain('headers="(request-target) host date digest"');

		const signatureMatch = /signature="(?<value>[^"]+)"/.exec(signature);
		expect(signatureMatch).not.toBeNull();
		const signatureBase64 = signatureMatch?.groups?.value;

		const stringToSign = [
			`(request-target): post ${url.pathname}`,
			`host: ${url.host}`,
			`date: ${date}`,
			`digest: ${digest}`,
		].join('\n');

		const isValid = verify(
			'sha256',
			Buffer.from(stringToSign, 'utf-8'),
			publicKey,
			Buffer.from(signatureBase64 ?? '', 'base64'),
		);
		expect(isValid).toBe(true);
	});

	test('does not verify against a tampered signing string', () => {
		const url = new URL('https://remote.example/activitypub/o/some-object');
		const { signature } = apex.computeHttpSignatureHeaders({
			method: 'get',
			url,
			privateKeyPem: privateKey,
			keyId: 'https://example.com/u/alice#main-key',
		});
		const signatureMatch = /signature="(?<value>[^"]+)"/.exec(signature);
		const signatureBase64 = signatureMatch?.groups?.value ?? '';

		const tamperedStringToSign = [
			`(request-target): get /activitypub/o/some-other-object`,
			`host: ${url.host}`,
			`date: ${new Date().toUTCString()}`,
		].join('\n');

		const isValid = verify(
			'sha256',
			Buffer.from(tamperedStringToSign, 'utf-8'),
			publicKey,
			Buffer.from(signatureBase64, 'base64'),
		);
		expect(isValid).toBe(false);
	});

	describe('apex computeRfc9421SignatureHeaders', () => {
		const { publicKey: edPublicKey, privateKey: edPrivateKey } = generateKeyPairSync('ed25519', {
			publicKeyEncoding: { type: 'spki', format: 'pem' },
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		});

		test('produces an RFC 9421 GET signature verifiable against signature base', () => {
			const url = 'https://remote.example/u/alice';
			const headers = apex.computeRfc9421SignatureHeaders({
				method: 'GET',
				url,
				keyId: 'https://example.com/u/alice#main-key',
				privateKeyPem: privateKey,
			});

			expect(headers['Signature-Input']).toMatch(
				/^sig1=\("@method" "@target-uri"\);created=\d+;keyid="https:\/\/example\.com\/u\/alice#main-key"$/,
			);
			expect(headers.Signature).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
			expect(headers['Content-Digest']).toBeUndefined();
		});

		test('produces an RFC 9421 POST signature with Content-Digest', () => {
			const url = 'https://remote.example/inbox';
			const body = { type: 'Create', actor: 'https://example.com/u/alice' };
			const headers = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url,
				keyId: 'https://example.com/u/alice#main-key',
				privateKeyPem: privateKey,
				body,
			});

			expect(headers['Signature-Input']).toMatch(
				/^sig1=\("@method" "@target-uri" "content-digest"\);created=\d+;keyid="https:\/\/example\.com\/u\/alice#main-key"$/,
			);
			expect(headers.Signature).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);
			expect(headers['Content-Digest']).toMatch(/^sha-256=:[A-Za-z0-9+/=]+:$/);
		});

		test('produces an Ed25519 RFC 9421 signature', () => {
			const url = 'https://remote.example/inbox';
			const body = JSON.stringify({ type: 'Follow' });
			const headers = apex.computeRfc9421SignatureHeaders({
				method: 'POST',
				url,
				keyId: 'https://example.com/u/alice#ed25519-key',
				privateKey: edPrivateKey,
				algorithm: 'ed25519',
				body,
			});

			expect(headers['Signature-Input']).toContain('alg="ed25519"');
			expect(headers.Signature).toMatch(/^sig1=:[A-Za-z0-9+/=]+:$/);

			const sigMatch = /^sig1=:(?<sig>[A-Za-z0-9+/=]+):$/.exec(headers.Signature);
			const sigBytes = Buffer.from(sigMatch?.groups?.sig ?? '', 'base64');
			const stringToSign = [
				`"@method": POST`,
				`"@target-uri": ${url}`,
				`"content-digest": ${headers['Content-Digest']}`,
				`"@signature-params": ${headers['Signature-Input'].slice('sig1='.length)}`,
			].join('\n');
			const isValid = verify(null, Buffer.from(stringToSign, 'utf-8'), edPublicKey, sigBytes);
			expect(isValid).toBe(true);
		});
	});
});
