import { createHash, timingSafeEqual, verify } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { first, isRecord } from '../values.js';
import { getApex, getLocals } from './locals.js';

export interface SignatureHeader {
	keyId: string;
	algorithm: string;
	headers: string[];
	signature: string;
	created?: number | undefined;
	expires?: number | undefined;
}

export const requireAuthorized = (_req: Request, res: Response, next: NextFunction): void => {
	const locals = getLocals(res);
	if (!locals.authorized) {
		res.sendStatus(403);
		return;
	}
	next();
};

export const requireAuthorizedOrPublic = (
	req: Request,
	res: Response,
	next: NextFunction,
): void => {
	const apex = getApex(req);
	const locals = getLocals(res);
	if (locals.target && !(apex.isPublic(locals.target) || locals.authorized)) {
		res.sendStatus(403);
		return;
	}
	next();
};

// PassportJS などが req.user に載せる認証済みユーザー
const authenticatedUsername = (req: Request): string | undefined => {
	const user: unknown = 'user' in req ? req.user : undefined;
	return isRecord(user) && typeof user.username === 'string' && user.username
		? user.username
		: undefined;
};

export const verifyAuthorization = (req: Request, res: Response, next: NextFunction): void => {
	const apex = getApex(req);
	const locals = getLocals(res);
	// if not already set, check for PassportJS-style auth
	if (locals.authorizedUserId === undefined || locals.authorizedUserId === null) {
		const username = authenticatedUsername(req);
		locals.authorizedUserId = username && apex.utils.usernameToIRI(username);
	}
	// if not already set, check authorization via ownership
	if (locals.authorized === undefined || locals.authorized === null) {
		locals.authorized = Boolean(
			locals.target &&
			locals.authorizedUserId &&
			apex.validateOwner(locals.target, { id: locals.authorizedUserId }),
		);
	}
	next();
};

const signatureParamPattern = /^\s*(?<name>[A-Za-z]+)\s*=\s*"(?<value>[^"]*)"\s*$/;

export const parseSignatureHeader = (rawHeader: unknown): SignatureHeader | null => {
	if (!rawHeader || typeof rawHeader !== 'string') {
		return null;
	}
	let header = rawHeader.trim();
	if (header.toLowerCase().startsWith('signature ')) {
		header = header.slice('signature '.length).trim();
	}
	const params = new Map<string, string>();
	for (const part of header.split(',')) {
		const match = signatureParamPattern.exec(part);
		if (!match?.groups?.name || match.groups.value === undefined) {
			return null;
		}
		params.set(match.groups.name, match.groups.value);
	}
	const keyId = params.get('keyId');
	const signature = params.get('signature');
	if (!keyId || !signature) {
		return null;
	}
	const headersParam = params.get('headers');
	const headers = headersParam ? headersParam.toLowerCase().split(/\s+/).filter(Boolean) : ['date'];
	const createdParam = params.get('created');
	const created =
		createdParam !== undefined && /^\d+$/.test(createdParam)
			? parseInt(createdParam, 10)
			: undefined;
	const expiresParam = params.get('expires');
	const expires =
		expiresParam !== undefined && /^\d+$/.test(expiresParam)
			? parseInt(expiresParam, 10)
			: undefined;
	return {
		keyId,
		algorithm: (params.get('algorithm') || 'rsa-sha256').toLowerCase(),
		headers,
		signature,
		created,
		expires,
	};
};

export const buildStringToSign = (
	req: Request,
	headerNames: string[],
	sigHead?: SignatureHeader,
): string | null => {
	const lines = [];
	for (const name of headerNames) {
		const lowerName = name.toLowerCase();
		if (lowerName === '(request-target)') {
			const path = req.originalUrl || req.url;
			lines.push(`(request-target): ${req.method.toLowerCase()} ${path}`);
		} else if (lowerName === '(created)') {
			if (sigHead?.created === undefined) {
				return null;
			}
			lines.push(`(created): ${sigHead.created}`);
		} else if (lowerName === '(expires)') {
			if (sigHead?.expires === undefined) {
				return null;
			}
			lines.push(`(expires): ${sigHead.expires}`);
		} else if (lowerName === 'host') {
			const host = req.get('host') ?? req.headers.host;
			if (host === undefined) {
				return null;
			}
			lines.push(`host: ${host}`);
		} else {
			const val = req.get(lowerName) ?? req.headers[lowerName];
			if (val === undefined) {
				return null;
			}
			lines.push(`${lowerName}: ${String(val)}`);
		}
	}
	return lines.join('\n');
};

const hashAlgorithms = new Map([
	['rsa-sha256', 'sha256'],
	['hs2019', 'sha256'],
	['rsa-sha512', 'sha512'],
	['rsa-sha1', 'sha1'],
]);

export const verifyHttpSignature = (
	sigHead: SignatureHeader,
	stringToSign: string,
	publicKeyPem: string,
): boolean => {
	const hashAlgo = hashAlgorithms.get(sigHead.algorithm.toLowerCase());
	if (hashAlgo === undefined) {
		return false;
	}

	try {
		const signatureBuffer = Buffer.from(sigHead.signature, 'base64');
		return verify(hashAlgo, Buffer.from(stringToSign, 'utf-8'), publicKeyPem, signatureBuffer);
	} catch {
		return false;
	}
};

const publicKeyPemOf = (signer: unknown): string | undefined => {
	if (!isRecord(signer)) {
		return undefined;
	}
	const publicKey = first(signer.publicKey);
	if (!isRecord(publicKey)) {
		return undefined;
	}
	const pem = first(publicKey.publicKeyPem);
	return typeof pem === 'string' && pem ? pem : undefined;
};

const CLOCK_SKEW_MARGIN_MS = 60 * 60 * 1000; // 1 hour
const EXPIRATION_WINDOW_LIMIT_MS = 12 * 60 * 60 * 1000; // 12 hours

export const verifySignature = async (
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> => {
	const apex = getApex(req);
	const locals = getLocals(res);
	const signatureHeader = req.get('signature') || req.get('authorization');

	if (!signatureHeader) {
		if (req.app.get('env') !== 'development') {
			apex.logger.warn('Request rejected: missing http signature');
			res.status(401).send('Missing http signature');
			return;
		}
		try {
			const actor = await apex.resolveObject(apex.actorIdFromActivity(req.body));
			locals.sender = actor;
			next();
		} catch (err) {
			apex.logger.warn('error resolving actor in dev mode', err);
			res.status(500).send();
		}
		return;
	}

	const sigHead = parseSignatureHeader(signatureHeader);
	if (!sigHead) {
		apex.logger.warn('Request rejected: unsupported or invalid signature header format');
		res.status(403).send('Invalid http signature');
		return;
	}

	const stringToSign = buildStringToSign(req, sigHead.headers, sigHead);
	if (stringToSign === null) {
		apex.logger.warn('Request rejected: signed headers missing from request');
		res.status(403).send('Invalid http signature');
		return;
	}

	const signedHeaders = sigHead.headers;
	if (!signedHeaders.includes('date') && !signedHeaders.includes('(created)')) {
		apex.logger.warn('Request rejected: signature must include date or (created) header');
		res.status(403).send('Invalid http signature');
		return;
	}

	if (req.method.toLowerCase() === 'post' && !signedHeaders.includes('digest')) {
		apex.logger.warn('Request rejected: POST request signature must include digest header');
		res.status(403).send('Invalid http signature');
		return;
	}

	let requestTimeMs: number | undefined;
	if (signedHeaders.includes('(created)') && sigHead.created !== undefined) {
		requestTimeMs = sigHead.created * 1000;
	} else {
		const dateHeader = req.get('date') ?? req.headers.date;
		if (typeof dateHeader === 'string') {
			const parsed = Date.parse(dateHeader);
			if (!Number.isNaN(parsed)) {
				requestTimeMs = parsed;
			}
		}
	}

	if (requestTimeMs === undefined) {
		apex.logger.warn('Request rejected: missing or invalid date in request');
		res.status(403).send('Invalid http signature');
		return;
	}

	const now = Date.now();
	if (requestTimeMs > now + CLOCK_SKEW_MARGIN_MS) {
		apex.logger.warn('Request rejected: request date is in the future');
		res.status(403).send('Invalid http signature');
		return;
	}

	const expiresTimeMs =
		sigHead.expires === undefined
			? requestTimeMs + EXPIRATION_WINDOW_LIMIT_MS
			: Math.min(sigHead.expires * 1000, requestTimeMs + EXPIRATION_WINDOW_LIMIT_MS);

	if (now > expiresTimeMs + CLOCK_SKEW_MARGIN_MS) {
		apex.logger.warn('Request rejected: request date is outside acceptable time window');
		res.status(403).send('Invalid http signature');
		return;
	}

	if (signedHeaders.includes('digest')) {
		const digestHeader = req.get('digest') ?? req.headers.digest;
		if (typeof digestHeader !== 'string') {
			apex.logger.warn('Request rejected: missing digest header');
			res.status(403).send('Invalid http signature');
			return;
		}

		let providedDigest: string | undefined;
		const digestPairs = digestHeader.split(',').map((part) => {
			const eqIdx = part.indexOf('=');
			if (eqIdx === -1) {
				return ['', part.trim()];
			}
			return [part.slice(0, eqIdx).trim().toLowerCase(), part.slice(eqIdx + 1).trim()];
		});
		const sha256Pair = digestPairs.find(([algo]) => algo === 'sha-256');
		if (sha256Pair?.[1]) {
			providedDigest = sha256Pair[1];
		} else if (digestPairs.length === 1 && digestPairs[0]?.[0] === '' && digestPairs[0][1]) {
			providedDigest = digestPairs[0][1];
		}

		if (!providedDigest) {
			apex.logger.warn(
				'Request rejected: digest header does not contain supported sha-256 algorithm',
			);
			res.status(403).send('Invalid http signature');
			return;
		}

		const rawBody = (req as { rawBody?: unknown }).rawBody;
		let bodyBuffer: Buffer | undefined;
		if (Buffer.isBuffer(rawBody)) {
			bodyBuffer = rawBody;
		} else if (typeof rawBody === 'string') {
			bodyBuffer = Buffer.from(rawBody, 'utf-8');
		} else if (Buffer.isBuffer(req.body)) {
			bodyBuffer = req.body;
		} else if (typeof req.body === 'string') {
			bodyBuffer = Buffer.from(req.body, 'utf-8');
		} else if (isRecord(req.body)) {
			bodyBuffer = Buffer.from(JSON.stringify(req.body), 'utf-8');
		}

		if (!bodyBuffer) {
			apex.logger.warn('Request rejected: unable to verify digest without raw request body');
			res.status(403).send('Invalid http signature');
			return;
		}

		const computedDigest = createHash('sha256').update(bodyBuffer).digest('base64');
		const providedBuffer = Buffer.from(providedDigest, 'base64');
		const computedBuffer = Buffer.from(computedDigest, 'base64');
		if (
			providedBuffer.length !== 32 ||
			computedBuffer.length !== 32 ||
			!timingSafeEqual(providedBuffer, computedBuffer)
		) {
			apex.logger.warn('Request rejected: body digest mismatch');
			res.status(403).send('Invalid http signature');
			return;
		}
	}

	const body: unknown = req.body;
	const type =
		isRecord(body) && typeof body.type === 'string' && body.type ? body.type.toLowerCase() : '';
	let cached = true;
	let signer;
	try {
		signer = await apex.resolveObject(sigHead.keyId, false, false, true);
		if (
			(type === 'delete' || type === 'update') &&
			(!signer || signer.type.toLowerCase() === 'tombstone')
		) {
			console.log(
				'Ignoring unverifiable %s from %s',
				type,
				isRecord(body) ? body.actor : undefined,
			);
			// user delete message that can't be verified because we don't have the user cached
			res.status(200).send();
			return;
		}
		if (!signer) {
			console.log('Fetching actor to verify signature %s', sigHead.keyId);
			cached = false;
			signer = await apex.resolveObject(sigHead.keyId);
		}
	} catch (err) {
		apex.logger.warn('error resolving signer for signature verification', err);
		res.status(500).send();
		return;
	}

	const signerKey = publicKeyPemOf(signer);
	if (!signer || signerKey === undefined) {
		apex.logger.warn(
			'Could not find key for %s (signer id: %s, type: %s)',
			sigHead.keyId,
			signer?.id,
			signer?.type,
		);
		res.status(403).send('Invalid http signature');
		return;
	}

	let valid = verifyHttpSignature(sigHead, stringToSign, signerKey);
	if (!valid && cached) {
		console.log('Refreshing key for %s', sigHead.keyId);
		// try refreshing cached key in case of key rotation
		try {
			signer = await apex.resolveObject(sigHead.keyId, false, true);
		} catch (err) {
			apex.logger.warn('error refreshing key for signature verification', err);
			res.status(500).send();
			return;
		}
		const refreshedKey = publicKeyPemOf(signer);
		if (refreshedKey !== undefined) {
			valid = verifyHttpSignature(sigHead, stringToSign, refreshedKey);
		}
	}

	if (!valid) {
		apex.logger.warn('Request rejected: invalid http signature');
		res.status(403).send('Invalid http signature');
		return;
	}

	locals.sender = signer;
	next();
};
