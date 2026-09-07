import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { computeHttpSignatureHeaders } from '../../src/security/httpSignature.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	publicKeyEncoding: { type: 'spki', format: 'pem' },
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('computeHttpSignatureHeaders', () => {
	test('produces a signature verifiable against the reconstructed signing string', () => {
		const url = new URL('https://remote.example/activitypub/o/some-object?x=1');
		const { date, signature } = computeHttpSignatureHeaders({
			url,
			privateKeyPem: privateKey,
			keyId: 'https://hakatashi.com/activitypub/u/hakatashi#main-key',
		});

		expect(signature).toContain('keyId="https://hakatashi.com/activitypub/u/hakatashi#main-key"');
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

	test('does not verify against a tampered signing string', () => {
		const url = new URL('https://remote.example/activitypub/o/some-object');
		const { signature } = computeHttpSignatureHeaders({
			url,
			privateKeyPem: privateKey,
			keyId: 'https://hakatashi.com/activitypub/u/hakatashi#main-key',
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
});
