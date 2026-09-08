import type { Request, Response } from 'express';
import { describe, expect, test, vi } from 'vitest';
import { rejectUnsupportedSignatureFormat } from '../../src/inboxSignature.js';

const makeReq = (headers: Record<string, string>) =>
	({
		get: (name: string) => headers[name.toLowerCase()],
	}) as unknown as Request;

const makeRes = () => {
	const res = {
		status: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
	};
	return res as unknown as Response & { status: typeof res.status; send: typeof res.send };
};

describe('rejectUnsupportedSignatureFormat (ADR-0036)', () => {
	test('lets a draft-cavage Signature header through', () => {
		const req = makeReq({
			signature:
				'keyId="https://remote.example/u/alice#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="abc123"',
		});
		const res = makeRes();
		const next = vi.fn();

		rejectUnsupportedSignatureFormat(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(res.status).not.toHaveBeenCalled();
	});

	// mastodon-test.hakatashi.com からの Like/Announce の実配送で観測した実際の値
	// (RFC 9421 の構造化フィールド形式)。apex の http-signature (draft-cavage 専用) に渡すと
	// 例外を投げ、apex 本体が 500 を返してしまうため、事前にここで弾く (→ Issue #55)。
	test('rejects an RFC 9421 style Signature header before apex sees it', () => {
		const req = makeReq({
			signature:
				'sig1=:PkejmApqXS4Yt5p6KfubWCPiglDYQXa9NY7oOyGO2r7R5GdotPDepwig6moyPXLvuhLYRpGLq==:',
		});
		const res = makeRes();
		const next = vi.fn();

		rejectUnsupportedSignatureFormat(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
	});

	test('lets requests without a Signature/Authorization header through unchanged', () => {
		const req = makeReq({});
		const res = makeRes();
		const next = vi.fn();

		rejectUnsupportedSignatureFormat(req, res, next);

		expect(next).toHaveBeenCalledOnce();
		expect(res.status).not.toHaveBeenCalled();
	});

	test('falls back to the Authorization header when Signature is absent', () => {
		const req = makeReq({ authorization: 'sig1=:abc==:' });
		const res = makeRes();
		const next = vi.fn();

		rejectUnsupportedSignatureFormat(req, res, next);

		expect(next).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(403);
	});
});
